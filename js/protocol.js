// protocol.js
// Gemeinsames Übertragungsprotokoll für Sender und Empfänger.
//
// Aufbau des Bitstroms (MSB-first):
//   SYNC      16 Bit   Fester Erkennungswert (0xAC9D)
//   LEN       16 Bit   Länge der Nutzdaten in Bytes
//   CRC16     16 Bit   CRC-16/CCITT-FALSE über die Nutzdaten-Bytes
//   PAYLOAD   LEN*8     UTF-8 kodierter Text
//   ENDSYNC   16 Bit   Abschluss-Markierung (0x5A3C)
//
// Die CRC dient gleichzeitig als Integritäts- UND als Sync-Validierung:
// Nur eine vollständig korrekte Kopie erfüllt CRC + ENDSYNC, deshalb sind
// zufällige Falsch-Treffer des SYNC-Wortes praktisch ausgeschlossen.

export const SYNC = 0xac9d;
export const ENDSYNC = 0x5a3c;
export const HEADER_BITS = 16 + 16 + 16; // SYNC + LEN + CRC
export const END_BITS = 16;

/** CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021). */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Hängt `value` als `width` Bits (MSB-first) an das Bit-Array an. */
function pushBits(bits, value, width) {
  for (let i = width - 1; i >= 0; i--) {
    bits.push((value >> i) & 1);
  }
}

/**
 * Baut den kompletten Bitstrom (Array aus 0/1) für einen gegebenen Text.
 * @returns {{ bits: number[], byteLength: number, crc: number }}
 */
export function buildBitstream(text) {
  const payload = new TextEncoder().encode(text);
  if (payload.length > 0xffff) {
    throw new Error('Nachricht zu lang (max. 65535 Bytes).');
  }
  const crc = crc16(payload);
  const bits = [];
  pushBits(bits, SYNC, 16);
  pushBits(bits, payload.length, 16);
  pushBits(bits, crc, 16);
  for (const byte of payload) pushBits(bits, byte, 8);
  pushBits(bits, ENDSYNC, 16);
  return { bits, byteLength: payload.length, crc };
}

/** Liest `width` Bits ab Position `pos` als vorzeichenlose Zahl. */
function readBits(buffer, pos, width) {
  let value = 0;
  for (let i = 0; i < width; i++) {
    value = (value << 1) | buffer[pos + i];
  }
  return value >>> 0;
}

function bytesToText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return '';
  }
}

/**
 * Zustandsbehafteter Decoder. Bits werden fortlaufend per append() eingespeist.
 * Hält den besten bisher gefundenen Sync-Kandidaten für die Fortschrittsanzeige.
 */
export class Decoder {
  constructor() {
    this.reset();
  }

  reset() {
    this.buffer = [];
    this.searchPos = 0;
    this.solved = null; // { text, byteLength }
    this.candidate = null; // { syncStart, byteLength, receivedBytes }
  }

  /** Verwirft alten Puffer, behält aber ein bereits gelöstes Ergebnis. */
  softReset() {
    this.buffer = [];
    this.searchPos = 0;
    this.candidate = null;
  }

  append(newBits) {
    for (const b of newBits) this.buffer.push(b);
    // Puffer begrenzen, damit er nicht unbegrenzt wächst.
    const MAX = 200000;
    if (this.buffer.length > MAX) {
      const drop = this.buffer.length - MAX;
      this.buffer.splice(0, drop);
      this.searchPos = Math.max(0, this.searchPos - drop);
    }
    this._scan();
  }

  _scan() {
    const buf = this.buffer;
    this.candidate = null;
    for (let pos = this.searchPos; pos + 16 <= buf.length; pos++) {
      if (readBits(buf, pos, 16) !== SYNC) continue;

      // Genug Bits für den Header?
      if (pos + HEADER_BITS > buf.length) {
        // SYNC erkannt, aber Header noch unvollständig -> warten.
        this.candidate = { syncStart: pos, byteLength: null, receivedBytes: 0 };
        return;
      }

      const len = readBits(buf, pos + 16, 16);
      const crc = readBits(buf, pos + 32, 16);
      const payloadStart = pos + HEADER_BITS;
      const totalBits = HEADER_BITS + len * 8 + END_BITS;

      if (pos + totalBits > buf.length) {
        // Vollständige Nutzdaten noch nicht da -> Fortschritt melden.
        const availPayloadBits = Math.max(0, buf.length - payloadStart);
        this.candidate = {
          syncStart: pos,
          byteLength: len,
          receivedBytes: Math.min(len, Math.floor(availPayloadBits / 8)),
        };
        return;
      }

      // Vollständiger Frame liegt vor -> prüfen.
      const bytes = [];
      for (let i = 0; i < len; i++) bytes.push(readBits(buf, payloadStart + i * 8, 8));
      const endVal = readBits(buf, payloadStart + len * 8, 16);
      const ok = crc16(bytes) === crc && endVal === ENDSYNC;

      if (ok) {
        this.solved = { text: bytesToText(bytes), byteLength: len };
        this.searchPos = pos + totalBits;
        return;
      }
      // Falscher Treffer (CRC/ENDSYNC passt nicht) -> hinter diesem SYNC weitersuchen.
      this.searchPos = pos + 1;
    }
    this.searchPos = Math.max(this.searchPos, buf.length - 16);
  }
}
