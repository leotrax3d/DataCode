// audio.js — Übertragung per Tönen (M-FSK) mit Web Audio.
// 16 Datentöne -> 4 Bit pro Symbol. Eine kurze Präambel (zwei abwechselnde
// Töne) hilft dem Empfänger beim Einrasten; danach folgen die Datensymbole.
// Der Bitstrom ist identisch zum visuellen Modus (protocol.js) inkl. FEC.

export const AUDIO = {
  F0: 1200, // erster Datenton (Hz)
  STEP: 150, // Tonabstand (Hz)
  M: 16, // Anzahl Töne
  BITS_PER_SYM: 4,
};
export const FREQS = Array.from({ length: AUDIO.M }, (_, i) => AUDIO.F0 + i * AUDIO.STEP);
const PREAMBLE_SYMS = 14; // abwechselnd Ton 0 / Ton 15

/** Goertzel-Energie einer Frequenz im Fenster [start, start+len). */
export function goertzel(samples, start, len, freq, sampleRate) {
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s0 = 0, s1 = 0, s2 = 0;
  const end = Math.min(samples.length, start + len);
  for (let i = start; i < end; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Klassifiziert ein Symbolfenster: dominanter Ton + Gesamtenergie. */
export function classify(samples, start, len, sampleRate, freqs) {
  // zentrale 60 % nutzen, um Übergangsränder zu meiden
  const margin = Math.floor(len * 0.2);
  const s = start + margin;
  const l = len - 2 * margin;
  let best = -1, bestE = -1, total = 0;
  for (let i = 0; i < freqs.length; i++) {
    const e = goertzel(samples, s, l, freqs[i], sampleRate);
    total += e;
    if (e > bestE) { bestE = e; best = i; }
  }
  return { index: best, energy: bestE, total, conf: total > 0 ? bestE / total : 0 };
}

/** RMS-Energie eines Fensters. */
function rms(samples, start, len) {
  let sum = 0;
  const end = Math.min(samples.length, start + len);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

/** Symbol-Indizes -> Bitstrom (BITS_PER_SYM Bits, MSB-first). */
export function symbolsToBits(syms) {
  const bits = [];
  for (const v of syms) for (let b = AUDIO.BITS_PER_SYM - 1; b >= 0; b--) bits.push((v >> b) & 1);
  return bits;
}

/** Bitstrom -> Symbol-Indizes (mit 0 aufgefüllt). */
export function bitsToSymbols(bits) {
  const syms = [];
  for (let i = 0; i < bits.length; i += AUDIO.BITS_PER_SYM) {
    let v = 0;
    for (let b = 0; b < AUDIO.BITS_PER_SYM; b++) v = (v << 1) | (bits[i + b] ?? 0);
    syms.push(v);
  }
  return syms;
}

/** Vollständige Tonsequenz (Präambel + Daten) als {freq, index}-Liste. */
export function buildToneSequence(bits) {
  const seq = [];
  for (let i = 0; i < PREAMBLE_SYMS; i++) {
    const idx = i % 2 === 0 ? 0 : AUDIO.M - 1;
    seq.push({ index: idx, freq: FREQS[idx] });
  }
  for (const v of bitsToSymbols(bits)) seq.push({ index: v, freq: FREQS[v] });
  return seq;
}

/**
 * Offline-Demodulation eines kompletten Sample-Puffers (für Tests & Referenz).
 * symbolSec muss dem Sender entsprechen.
 * @returns {number[]} Bitstrom
 */
export function demodulate(samples, sampleRate, { symbolSec }) {
  const win = Math.round(symbolSec * sampleRate);
  const hop = Math.max(1, Math.round(win / 4));
  // Energie-Hüllkurve -> aktiven Bereich finden
  let maxR = 0;
  for (let s = 0; s + win <= samples.length; s += hop) maxR = Math.max(maxR, rms(samples, s, win));
  const thr = maxR * 0.2;
  let t0 = -1, tEnd = samples.length;
  for (let s = 0; s + win <= samples.length; s += hop) {
    if (rms(samples, s, win) > thr) { t0 = s; break; }
  }
  if (t0 < 0) return [];
  // Ende: längere Stille nach t0
  let silence = 0;
  for (let s = t0; s + win <= samples.length; s += hop) {
    if (rms(samples, s, win) < thr) { silence += hop; if (silence > win * 1.5) { tEnd = s; break; } }
    else silence = 0;
  }
  // Symbole ab t0 im Raster win abtasten
  const bits = [];
  for (let k = 0; t0 + (k + 1) * win <= tEnd; k++) {
    const c = classify(samples, t0 + k * win, win, sampleRate, FREQS);
    for (let b = AUDIO.BITS_PER_SYM - 1; b >= 0; b--) bits.push((c.index >> b) & 1);
  }
  return bits;
}

// ---------------------------------------------------------------- Sender ----
export class AudioSender {
  constructor(opts = {}) {
    this.onState = opts.onState || (() => {});
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.timer = null;
    this.running = false;
  }

  start(bits, { symbolSec = 0.06, gapSec = 0.4 } = {}) {
    this.stop();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(this.ctx.destination);
    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.connect(this.gain);
    this.osc.start();
    this.running = true;

    const seq = buildToneSequence(bits);
    const loopSec = seq.length * symbolSec + gapSec;
    let loops = 0;
    let next = this.ctx.currentTime + 0.1;

    const schedule = () => {
      if (!this.running) return;
      // einen kompletten Durchlauf in die Zukunft planen
      while (next < this.ctx.currentTime + 0.5) {
        for (const sym of seq) {
          this.osc.frequency.setValueAtTime(sym.freq, next);
          // sanftes An/Aus gegen Klicks
          this.gain.gain.setValueAtTime(0.0001, next);
          this.gain.gain.exponentialRampToValueAtTime(0.25, next + Math.min(0.005, symbolSec * 0.2));
          this.gain.gain.setValueAtTime(0.25, next + symbolSec - 0.003);
          next += symbolSec;
        }
        // Pause (Stille)
        this.gain.gain.setValueAtTime(0.0001, next);
        next += gapSec;
        loops++;
      }
      this.onState({ running: true, loops, symbolSec, loopSec, symbols: seq.length });
      this.timer = setTimeout(schedule, 200);
    };
    schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.osc?.stop(); } catch {}
    try { this.ctx?.close(); } catch {}
    this.osc = this.gain = this.ctx = null;
    this.onState({ running: false });
  }
}

// -------------------------------------------------------------- Empfänger ----
export class AudioReceiver {
  constructor(opts = {}) {
    this.onSymbols = opts.onSymbols || (() => {});
    this.onState = opts.onState || (() => {});
    this.running = false;
  }

  async start({ symbolSec = 0.06 } = {}) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      this.onState({ error: 'Mikrofonzugriff verweigert: ' + e.message });
      return false;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.symbolSec = symbolSec;
    this.win = Math.round(symbolSec * this.ctx.sampleRate);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    const bufSize = 2048;
    this.proc = this.ctx.createScriptProcessor(bufSize, 1, 1);
    this.buf = new Float32Array(0);
    this.absStart = 0; // absolute Sample-Position von buf[0]
    this.cursor = 0; // nächste Symbolgrenze (absolut)
    this.state = 'idle';
    this.maxR = 0.0001;
    this.silenceSyms = 0;
    this.symCount = 0;
    this.running = true;

    this.proc.onaudioprocess = (e) => this._process(e.inputBuffer.getChannelData(0));
    this.src.connect(this.proc);
    this.proc.connect(this.ctx.destination); // nötig, damit onaudioprocess feuert
    return true;
  }

  _append(block) {
    const merged = new Float32Array(this.buf.length + block.length);
    merged.set(this.buf, 0);
    merged.set(block, this.buf.length);
    this.buf = merged;
  }

  _trim() {
    // alles vor cursor (bzw. einem Sicherheitsfenster) verwerfen
    const keepFrom = Math.max(0, (this.state === 'receiving' ? this.cursor : this.absStart + this.buf.length - this.win * 3) - this.absStart);
    if (keepFrom > this.win) {
      this.buf = this.buf.slice(keepFrom);
      this.absStart += keepFrom;
    }
  }

  _process(block) {
    if (!this.running) return;
    this._append(block);
    const r = rms(this.buf, this.buf.length - block.length, block.length);
    this.maxR = Math.max(this.maxR * 0.999, r);
    const thr = this.maxR * 0.2;

    if (this.state === 'idle') {
      if (r > thr) {
        // Onset: ungefähre Symbolgrenze = Beginn dieses Blocks
        this.state = 'receiving';
        this.cursor = this.absStart + this.buf.length - block.length;
        this.silenceSyms = 0;
      }
    }
    if (this.state === 'receiving') {
      // alle vollständigen Symbole bis zum Pufferende verarbeiten
      while (this.cursor + this.win <= this.absStart + this.buf.length) {
        const local = this.cursor - this.absStart;
        const c = classify(this.buf, local, this.win, this.ctx.sampleRate, FREQS);
        if (c.total < thr * thr * this.win * 0.05) {
          this.silenceSyms++;
        } else {
          this.silenceSyms = 0;
          const bits = [];
          for (let b = AUDIO.BITS_PER_SYM - 1; b >= 0; b--) bits.push((c.index >> b) & 1);
          this.onSymbols(bits);
          this.symCount++;
        }
        this.cursor += this.win;
        if (this.silenceSyms > 4) {
          // Übertragung vorbei -> auf nächsten Durchlauf warten
          this.state = 'idle';
          this.onState({ running: true, gap: true, symCount: this.symCount });
          break;
        }
      }
    }
    this._trim();
    this.onState({ running: true, state: this.state, level: r, symCount: this.symCount });
  }

  stop() {
    this.running = false;
    try { this.proc && (this.proc.onaudioprocess = null); } catch {}
    try { this.src?.disconnect(); this.proc?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx?.close(); } catch {}
    this.ctx = this.proc = this.src = this.stream = null;
  }
}
