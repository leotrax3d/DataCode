// receiver.js — Empfangsmodus: Balken über die Kamera einlesen und dekodieren.
import { Decoder } from './protocol.js';

const ROI_W = 256; // Analysebreite (Spalten) der Region of Interest
const ROI_H = 24; // Höhe (gemittelte Zeilen)
const MAX_BARS = 12; // plausible Obergrenze inkl. Takt
const MIN_CONTRAST = 28; // min. Helligkeitsabstand für gültiges Signal (0..255)
const STABLE_FRAMES = 8; // gleiche Balkenzahl nötig zum Einrasten
const LOST_MS = 1600; // ohne Taktflanke -> Signal verloren
const RESEARCH_MS = 3500; // danach: Balken neu suchen

export class Receiver {
  constructor(video, opts = {}) {
    this.video = video;
    this.onState = opts.onState || (() => {});
    this.decoder = new Decoder();
    this.running = false;
    this.stream = null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = ROI_W;
    this.canvas.height = ROI_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this._raf = null;
    this._resetLock();
  }

  _resetLock() {
    this.state = 'SEARCHING'; // SEARCHING | LOCKED
    this.bars = 0;
    this.recentCounts = [];
    this.barCenters = [];
    this.clockWhite = null;
    this.clockBlack = null;
    this.clockBin = null;
    this.dataMin = [];
    this.dataMax = [];
    this.symbolSamples = []; // pro Frame: Array von Datenbits
    this.lastEdge = performance.now();
    this.symbolPeriod = null; // gemessene Symboldauer in ms (EMA)
    this.fpsT = performance.now();
    this.fpsN = 0;
    this.fps = 0;
  }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      this.onState({ error: 'Kamerazugriff verweigert oder nicht möglich: ' + e.message });
      return false;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.decoder.reset();
    this._resetLock();
    this.running = true;
    this._loop();
    return true;
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  rescan() {
    this.decoder.reset();
    this._resetLock();
  }

  /** Mittelt die ROI-Spalten zu einem 1D-Helligkeitsprofil (Länge ROI_W). */
  _profile() {
    const v = this.video;
    if (!v.videoWidth) return null;
    // ROI = zentrales Band (80% Breite, 36% Höhe), passend zur Bildschirm-Hilfsbox.
    const sw = v.videoWidth * 0.8;
    const sh = v.videoHeight * 0.36;
    const sx = (v.videoWidth - sw) / 2;
    const sy = (v.videoHeight - sh) / 2;
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, ROI_W, ROI_H);
    const img = this.ctx.getImageData(0, 0, ROI_W, ROI_H).data;
    const prof = new Float32Array(ROI_W);
    for (let x = 0; x < ROI_W; x++) {
      let sum = 0;
      for (let y = 0; y < ROI_H; y++) {
        const i = (y * ROI_W + x) * 4;
        sum += 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      }
      prof[x] = sum / ROI_H;
    }
    // leichte Glättung gegen Rauschen
    const sm = new Float32Array(ROI_W);
    for (let x = 0; x < ROI_W; x++) {
      const a = prof[Math.max(0, x - 1)];
      const b = prof[x];
      const c = prof[Math.min(ROI_W - 1, x + 1)];
      sm[x] = (a + b + c) / 3;
    }
    return sm;
  }

  _avgAround(prof, center, halfWidth) {
    const a = Math.max(0, Math.round(center - halfWidth));
    const b = Math.min(ROI_W - 1, Math.round(center + halfWidth));
    let sum = 0;
    for (let x = a; x <= b; x++) sum += prof[x];
    return sum / (b - a + 1);
  }

  /** Zählt Balken (Runs) im Kalibrier-Streifenmuster. */
  _countBars(prof) {
    let min = Infinity, max = -Infinity;
    for (const v of prof) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const contrast = max - min;
    if (contrast < MIN_CONTRAST) return { count: 0, contrast };
    const thr = (min + max) / 2;
    const hys = contrast * 0.15;
    const minRun = ROI_W / (MAX_BARS * 2.5);
    let runs = 0;
    let state = null;
    let runLen = 0;
    for (let x = 0; x < ROI_W; x++) {
      let s = state;
      if (prof[x] > thr + hys) s = 1;
      else if (prof[x] < thr - hys) s = 0;
      if (s !== state) {
        if (state !== null && runLen >= minRun) runs++;
        state = s;
        runLen = 0;
      }
      runLen++;
    }
    if (state !== null && runLen >= minRun) runs++;
    return { count: runs, contrast };
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    this.fpsN++;
    if (now - this.fpsT >= 500) {
      this.fps = Math.round((this.fpsN * 1000) / (now - this.fpsT));
      this.fpsT = now;
      this.fpsN = 0;
    }

    const prof = this._profile();
    if (prof) {
      if (this.state === 'SEARCHING') this._search(prof, now);
      else this._receive(prof, now);
    }
    this._emit();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  _search(prof, now) {
    const { count, contrast } = this._countBars(prof);
    this.lastContrast = contrast;
    if (count >= 2 && count <= MAX_BARS) {
      this.recentCounts.push(count);
      if (this.recentCounts.length > STABLE_FRAMES) this.recentCounts.shift();
      // Modus der letzten Zählungen
      if (this.recentCounts.length >= STABLE_FRAMES) {
        const freq = {};
        for (const c of this.recentCounts) freq[c] = (freq[c] || 0) + 1;
        let mode = 0, modeN = 0;
        for (const c in freq) if (freq[c] > modeN) { modeN = freq[c]; mode = +c; }
        if (modeN >= STABLE_FRAMES * 0.6 && mode >= 2) {
          this._lock(mode);
        }
      }
    } else {
      this.recentCounts = [];
    }
  }

  _lock(bars) {
    this.bars = bars;
    this.barCenters = [];
    for (let i = 0; i < bars; i++) this.barCenters.push(((i + 0.5) / bars) * ROI_W);
    this.barHalf = (ROI_W / bars) * 0.28;
    this.clockWhite = null;
    this.clockBlack = null;
    this.clockBin = null;
    this.dataMin = new Array(bars - 1).fill(Infinity);
    this.dataMax = new Array(bars - 1).fill(-Infinity);
    this.symbolSamples = [];
    this.lastEdge = performance.now();
    this.state = 'LOCKED';
  }

  _receive(prof, now) {
    const clockLum = this._avgAround(prof, this.barCenters[0], this.barHalf);
    const data = [];
    for (let j = 1; j < this.bars; j++) {
      data.push(this._avgAround(prof, this.barCenters[j], this.barHalf));
    }

    // Takt-Pegel nachführen (Takt durchläuft sicher beide Extreme).
    this.clockWhite = this.clockWhite == null ? clockLum : Math.max(clockLum, this.clockWhite * 0.995 + clockLum * 0.005);
    this.clockBlack = this.clockBlack == null ? clockLum : Math.min(clockLum, this.clockBlack * 0.995 + clockLum * 0.005);
    const cContrast = this.clockWhite - this.clockBlack;
    const thr = (this.clockWhite + this.clockBlack) / 2;
    const hys = Math.max(6, cContrast * 0.2);

    // Datenbalken: adaptive Min/Max je Balken.
    const bits = [];
    for (let j = 0; j < data.length; j++) {
      this.dataMax[j] = Math.max(data[j], this.dataMax[j] * 0.997 + data[j] * 0.003);
      this.dataMin[j] = Math.min(data[j], this.dataMin[j] * 0.997 + data[j] * 0.003);
      const dthr = (this.dataMax[j] + this.dataMin[j]) / 2;
      bits.push(data[j] > dthr ? 1 : 0);
    }
    this.symbolSamples.push(bits);
    if (this.symbolSamples.length > 60) this.symbolSamples.shift();

    // Taktflanke (mit Hysterese) erkennen.
    let cur = this.clockBin;
    if (clockLum > thr + hys) cur = 1;
    else if (clockLum < thr - hys) cur = 0;

    if (this.clockBin !== null && cur !== this.clockBin && cur !== null) {
      // Flanke -> Symbol abschließen: Mehrheitsentscheid je Datenbalken.
      const dt = now - this.lastEdge;
      if (dt > 20 && dt < 2000) {
        this.symbolPeriod = this.symbolPeriod == null ? dt : this.symbolPeriod * 0.8 + dt * 0.2;
      }
      this._commitSymbol();
      this.lastEdge = now;
    }
    this.clockBin = cur;

    // Signalverlust behandeln.
    if (now - this.lastEdge > RESEARCH_MS) {
      this.decoder.softReset();
      this._resetLock(); // zurück zur Balkensuche
    } else if (now - this.lastEdge > LOST_MS) {
      this.signalLost = true;
    } else {
      this.signalLost = false;
    }
  }

  _commitSymbol() {
    const samples = this.symbolSamples;
    if (samples.length === 0) return;
    // Randframes (Übergang/Bewegungsunschärfe) verwerfen, falls genug da sind.
    let use = samples;
    if (samples.length >= 4) use = samples.slice(1, -1);
    const nb = this.bars - 1;
    const out = [];
    for (let j = 0; j < nb; j++) {
      let s = 0;
      for (const smp of use) s += smp[j];
      out.push(s * 2 >= use.length ? 1 : 0);
    }
    this.symbolSamples = [];
    this.decoder.append(out);
  }

  _emit() {
    const d = this.decoder;
    let progress = null, bytes = null, total = null;
    if (d.solved) {
      progress = 1;
    } else if (d.candidate && d.candidate.byteLength != null && d.candidate.byteLength < 60000) {
      total = d.candidate.byteLength;
      bytes = d.candidate.receivedBytes;
      progress = total > 0 ? bytes / total : 0;
    }
    this.onState({
      running: this.running,
      mode: this.state,
      bars: this.bars,
      dataBars: this.bars > 0 ? this.bars - 1 : 0,
      fps: this.fps,
      contrast: Math.round(this.lastContrast || 0),
      signalLost: !!this.signalLost,
      solved: d.solved,
      candidateType: d.candidate ? d.candidate.type : null,
      symbolPeriod: this.symbolPeriod,
      progress,
      bytes,
      total,
    });
  }
}
