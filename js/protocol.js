// protocol.js
// Gemeinsames Übertragungsprotokoll für Sender und Empfänger.
//
// Aufbau des Bitstroms (MSB-first):
//   SYNC      16 Bit   Fester Erkennungswert (0xAC9D)
//   TYPE       8 Bit   0 = Text (UTF-8), 1 = Datei
//   LEN       32 Bit   Länge der Nutzdaten in Bytes
//   CRC32     32 Bit   CRC-32 (IEEE) über die Nutzdaten-Bytes
//   PAYLOAD   LEN*8     Nutzdaten
//   ENDSYNC   16 Bit   Abschluss-Markierung (0x5A3C)
//
// Datei-Nutzdaten (TYPE = 1) sind selbstbeschreibend:
//   nameLen 16 | name (UTF-8) | mimeLen 16 | mime (UTF-8) | dateiBytes …
//
// Die CRC dient gleichzeitig als Integritäts- UND als Sync-Validierung:
// Nur eine vollständig korrekte Kopie erfüllt CRC + ENDSYNC, deshalb sind
// zufällige Falsch-Treffer des SYNC-Wortes praktisch ausgeschlossen.

export const SYNC = 0xac9d;
export const ENDSYNC = 0x5a3c;
export const HEADER_BITS = 16 + 8 + 32 + 32; // SYNC + TYPE + LEN + CRC
export const END_BITS = 16;
export const TYPE_TEXT = 0;
export const TYPE_FILE = 1;
const MAX_LEN = 25 * 1024 * 1024; // Plausibilitätsgrenze gegen Falsch-Syncs (25 MB)

/** CRC-32 (IEEE 802.3, reflektiert). */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Hängt `value` als `width` Bits (MSB-first) an das Bit-Array an. */
function pushBits(bits, value, width) {
  for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

const utf8 = (s) => new TextEncoder().encode(s);

/** Baut den kompletten Bitstrom für beliebige Nutzdaten-Bytes. */
export function buildBitstream(type, payloadBytes) {
  if (payloadBytes.length > MAX_LEN) throw new Error('Nutzdaten zu groß.');
  const crc = crc32(payloadBytes);
  const bits = [];
  pushBits(bits, SYNC, 16);
  pushBits(bits, type, 8);
  pushBits(bits, payloadBytes.length, 32);
  pushBits(bits, crc, 32);
  for (let i = 0; i < payloadBytes.length; i++) pushBits(bits, payloadBytes[i], 8);
  pushBits(bits, ENDSYNC, 16);
  return { bits, byteLength: payloadBytes.length, crc };
}

/** Komfort: Text-Frame. */
export function buildTextFrame(text) {
  return buildBitstream(TYPE_TEXT, utf8(text));
}

/** Komfort: Datei-Frame mit Name + MIME-Typ. */
export function buildFileFrame(name, mime, fileBytes) {
  const nameB = utf8(name || 'datei');
  const mimeB = utf8(mime || 'application/octet-stream');
  const payload = new Uint8Array(2 + nameB.length + 2 + mimeB.length + fileBytes.length);
  const dv = new DataView(payload.buffer);
  let o = 0;
  dv.setUint16(o, nameB.length); o += 2;
  payload.set(nameB, o); o += nameB.length;
  dv.setUint16(o, mimeB.length); o += 2;
  payload.set(mimeB, o); o += mimeB.length;
  payload.set(fileBytes, o);
  return buildBitstream(TYPE_FILE, payload);
}

/** Interpretiert dekodierte Nutzdaten in ein nutzbares Objekt. */
export function decodePayload(type, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (type === TYPE_FILE) {
    try {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let o = 0;
      const nameLen = dv.getUint16(o); o += 2;
      const name = new TextDecoder().decode(u8.subarray(o, o + nameLen)); o += nameLen;
      const mimeLen = dv.getUint16(o); o += 2;
      const mime = new TextDecoder().decode(u8.subarray(o, o + mimeLen)); o += mimeLen;
      const data = u8.subarray(o);
      return { kind: 'file', name, mime, bytes: data, size: data.length };
    } catch {
      return { kind: 'file', name: 'datei.bin', mime: 'application/octet-stream', bytes: u8, size: u8.length };
    }
  }
  return { kind: 'text', text: bytesToText(u8) };
}

/** Liest `width` Bits ab Position `pos` als vorzeichenlose Zahl. */
function readBits(buffer, pos, width) {
  let value = 0;
  for (let i = 0; i < width; i++) value = (value << 1) | buffer[pos + i];
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
    this.solved = null; // { type, bytes, byteLength }
    this.candidate = null; // { syncStart, type, byteLength, receivedBytes }
  }

  /** Verwirft alten Puffer, behält aber ein bereits gelöstes Ergebnis. */
  softReset() {
    this.buffer = [];
    this.searchPos = 0;
    this.candidate = null;
  }

  append(newBits) {
    for (const b of newBits) this.buffer.push(b);
    const MAX = 4_000_000;
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

      if (pos + HEADER_BITS > buf.length) {
        this.candidate = { syncStart: pos, type: null, byteLength: null, receivedBytes: 0 };
        return;
      }

      const type = readBits(buf, pos + 16, 8);
      const len = readBits(buf, pos + 24, 32);
      const crc = readBits(buf, pos + 56, 32);

      if (len > MAX_LEN) {
        // unplausible Länge -> Falsch-Sync, weitersuchen
        this.searchPos = pos + 1;
        continue;
      }

      const payloadStart = pos + HEADER_BITS;
      const totalBits = HEADER_BITS + len * 8 + END_BITS;

      if (pos + totalBits > buf.length) {
        const availPayloadBits = Math.max(0, buf.length - payloadStart);
        this.candidate = {
          syncStart: pos,
          type,
          byteLength: len,
          receivedBytes: Math.min(len, Math.floor(availPayloadBits / 8)),
        };
        return;
      }

      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = readBits(buf, payloadStart + i * 8, 8);
      const endVal = readBits(buf, payloadStart + len * 8, 16);
      const ok = crc32(bytes) === crc && endVal === ENDSYNC;

      if (ok) {
        this.solved = { type, bytes, byteLength: len };
        this.searchPos = pos + totalBits;
        return;
      }
      this.searchPos = pos + 1;
    }
    this.searchPos = Math.max(this.searchPos, buf.length - 16);
  }
}
