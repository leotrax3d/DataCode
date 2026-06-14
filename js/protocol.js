// protocol.js
// Gemeinsames Übertragungsprotokoll für visuelle UND Audio-Übertragung.
//
// Innere Nachricht (msg), durch CRC32 abgesichert:
//   TYPE   1 Byte    0 = Text (UTF-8), 1 = Datei
//   LEN    4 Byte    Länge der Nutzdaten in Bytes
//   CRC32  4 Byte    CRC-32 über die Nutzdaten
//   PAYLOAD LEN Byte Nutzdaten (Datei = selbstbeschreibend, s. u.)
//
// Optionale Fehlerkorrektur (FEC): Reed-Solomon über GF(256), blockweise
// (KBLOCK Datenbytes + PARITY Paritätsbytes je Block) + Interleaving gegen
// Bündelfehler. PARITY = 0 bedeutet "keine FEC".
//
// Übertragener Rahmen (Bit-/Symbolstrom, MSB-first):
//   SYNC      16 Bit  (0xAC9D)
//   PARITY     8 Bit  Paritätsbytes je Block (0 = keine FEC)
//   CODEDLEN  32 Bit  Anzahl der kodierten Bytes
//   CODED     …       kodierte Bytes (FEC) bzw. msg
//   ENDSYNC   16 Bit  (0x5A3C)
//
// Datei-Nutzdaten (TYPE = 1) sind selbstbeschreibend:
//   nameLen 16 | name | mimeLen 16 | mime | dateiBytes …

import { rsEncode, rsDecode } from './rs.js';

export const SYNC = 0xac9d;
export const ENDSYNC = 0x5a3c;
export const TYPE_TEXT = 0;
export const TYPE_FILE = 1;
export const KBLOCK = 32; // Datenbytes je FEC-Block
const HEADER_BITS = 16 + 8 + 32;
const END_BITS = 16;
const MAX_LEN = 25 * 1024 * 1024;

// CRC-32 (IEEE) -----------------------------------------------------------
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

const utf8 = (s) => new TextEncoder().encode(s);

// FEC --------------------------------------------------------------------
/** Kodiert msg blockweise mit Reed-Solomon und verschachtelt (interleave). */
function fecEncode(msg, parity) {
  const n = KBLOCK + parity;
  const nBlocks = Math.max(1, Math.ceil(msg.length / KBLOCK));
  const padded = new Uint8Array(nBlocks * KBLOCK);
  padded.set(msg, 0);
  const blocks = [];
  for (let b = 0; b < nBlocks; b++) {
    blocks.push(rsEncode(padded.subarray(b * KBLOCK, (b + 1) * KBLOCK), parity));
  }
  // Interleaving: spaltenweise senden -> Bündelfehler verteilen sich auf Blöcke
  const out = new Uint8Array(nBlocks * n);
  let o = 0;
  for (let col = 0; col < n; col++) for (let b = 0; b < nBlocks; b++) out[o++] = blocks[b][col];
  return out;
}

/** Kehrt fecEncode um und korrigiert Fehler. Gibt msg-Bytes oder null zurück. */
function fecDecode(coded, parity) {
  const n = KBLOCK + parity;
  if (coded.length % n !== 0) return null;
  const nBlocks = coded.length / n;
  const blocks = [];
  for (let b = 0; b < nBlocks; b++) blocks.push(new Uint8Array(n));
  let o = 0;
  for (let col = 0; col < n; col++) for (let b = 0; b < nBlocks; b++) blocks[b][col] = coded[o++];
  const out = new Uint8Array(nBlocks * KBLOCK);
  for (let b = 0; b < nBlocks; b++) {
    const dec = rsDecode(blocks[b], parity);
    if (!dec) return null;
    out.set(dec.subarray(0, KBLOCK), b * KBLOCK);
  }
  return out;
}

// Frame-Aufbau -----------------------------------------------------------
function pushBits(bits, value, width) {
  for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Baut den Bitstrom für beliebige Nutzdaten-Bytes mit optionaler FEC. */
export function buildBitstream(type, payloadBytes, parity = 0) {
  if (payloadBytes.length > MAX_LEN) throw new Error('Nutzdaten zu groß.');
  const msg = new Uint8Array(1 + 4 + 4 + payloadBytes.length);
  const dv = new DataView(msg.buffer);
  dv.setUint8(0, type);
  dv.setUint32(1, payloadBytes.length);
  dv.setUint32(5, crc32(payloadBytes));
  msg.set(payloadBytes, 9);

  const coded = parity > 0 ? fecEncode(msg, parity) : msg;
  const bits = [];
  pushBits(bits, SYNC, 16);
  pushBits(bits, parity, 8);
  pushBits(bits, coded.length, 32);
  for (let i = 0; i < coded.length; i++) pushBits(bits, coded[i], 8);
  pushBits(bits, ENDSYNC, 16);
  return { bits, byteLength: payloadBytes.length, codedLength: coded.length };
}

export function buildTextFrame(text, parity = 0) {
  return buildBitstream(TYPE_TEXT, utf8(text), parity);
}

export function buildFileFrame(name, mime, fileBytes, parity = 0) {
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
  return buildBitstream(TYPE_FILE, payload, parity);
}

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

/** Versucht, aus rohen msg-Bytes Typ/Länge/CRC zu prüfen und zu lösen. */
function parseMessage(msg) {
  if (msg.length < 9) return null;
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const type = dv.getUint8(0);
  const len = dv.getUint32(1);
  const crc = dv.getUint32(5);
  if (len > MAX_LEN || 9 + len > msg.length) return null;
  const payload = msg.subarray(9, 9 + len);
  if (crc32(payload) !== crc) return null;
  return { type, bytes: Uint8Array.from(payload), byteLength: len };
}

/**
 * Zustandsbehafteter Decoder. Bits werden fortlaufend per append() eingespeist.
 */
export class Decoder {
  constructor() {
    this.reset();
  }
  reset() {
    this.buffer = [];
    this.searchPos = 0;
    this.solved = null; // { type, bytes, byteLength }
    this.candidate = null; // { syncStart, codedLen, receivedCoded, parity }
  }
  softReset() {
    this.buffer = [];
    this.searchPos = 0;
    this.candidate = null;
  }
  append(newBits) {
    for (const b of newBits) this.buffer.push(b);
    const MAX = 8_000_000;
    if (this.buffer.length > MAX) {
      const drop = this.buffer.length - MAX;
      this.buffer.splice(0, drop);
      this.searchPos = Math.max(0, this.searchPos - drop);
    }
    this._scan();
  }
  _scan() {
    const buf = this.buffer;
    let cand = null; // erster noch unvollständiger Frame-Kandidat
    for (let pos = this.searchPos; pos + 16 <= buf.length; pos++) {
      if (readBits(buf, pos, 16) !== SYNC) continue;

      if (pos + HEADER_BITS > buf.length) {
        // Header noch nicht komplett -> spätere SYNCs sind erst recht unvollständig.
        if (!cand) cand = { syncStart: pos, codedLen: null, receivedCoded: 0, parity: null };
        break;
      }
      const parity = readBits(buf, pos + 16, 8);
      const codedLen = readBits(buf, pos + 24, 32);
      if (codedLen > MAX_LEN || codedLen < 1 || parity > 32) continue; // Falsch-Sync

      const dataStart = pos + HEADER_BITS;
      const totalBits = HEADER_BITS + codedLen * 8 + END_BITS;
      if (pos + totalBits > buf.length) {
        // Dieser Frame ist noch nicht vollständig – aber ein späterer, kürzerer
        // Frame könnte schon komplett sein, deshalb weiterscannen.
        if (!cand) {
          const availBytes = Math.max(0, Math.floor((buf.length - dataStart) / 8));
          cand = { syncStart: pos, codedLen, receivedCoded: Math.min(codedLen, availBytes), parity };
        }
        continue;
      }
      const coded = new Uint8Array(codedLen);
      for (let i = 0; i < codedLen; i++) coded[i] = readBits(buf, dataStart + i * 8, 8);
      const endVal = readBits(buf, dataStart + codedLen * 8, 16);
      if (endVal !== ENDSYNC) continue; // Falsch-Sync
      const msg = parity > 0 ? fecDecode(coded, parity) : coded;
      const parsed = msg ? parseMessage(msg) : null;
      if (parsed) {
        this.solved = parsed;
        this.candidate = null;
        this.searchPos = pos + totalBits;
        return;
      }
      // vollständig, aber ungültig (CRC/FEC) -> als Falsch-Sync überspringen
    }
    this.candidate = cand;
    // searchPos nur bis zum ersten noch wartenden Frame vorrücken.
    this.searchPos = cand ? cand.syncStart : Math.max(this.searchPos, buf.length - 16);
  }
}
