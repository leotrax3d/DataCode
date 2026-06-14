// receiver.js — Visueller Empfangsmodus: Balken über die Kamera einlesen.
import { getPalette, classifyValue } from './palette.js';

const ROI_W = 256;
const ROI_H = 28;
const MAX_BARS = 12;
const MIN_CONTRAST = 22;
const STABLE_FRAMES = 6;
const LOST_MS = 1600;
const RESEARCH_MS = 4000;

export class Receiver {
  constructor(video, opts = {}) {
    this.video = video;
    this.onState = opts.onState || (() => {});
    this.onBits = opts.onBits || (() => {});
    this.paletteId = 'bw';
    this.running = false;
    this.stream = null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = ROI_W;
    this.canvas.height = ROI_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this._raf = null;
    this._resetLock();
  }

  setPalette(id) {
    this.paletteId = id;
  }

  _resetLock() {
    this.state = 'SEARCHING';
    this.bars = 0;
    this.recentCounts = [];
    this.barCenters = [];
    this.clockWhite = null;
    this.clockBlack = null;
    this.clockBin = null;
    this.refMin = [];
    this.refMax = [];
    this.symbolSamples = [];
    this.lastEdge = performance.now();
    this.symbolPeriod = null;
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
    this._resetLock();
  }

  /** Liefert 1D-Profile (Helligkeit + RGB) der zentralen ROI. */
  _profile() {
    const v = this.video;
    if (!v.videoWidth) return null;
    // Zentrale 3:2-Region (gleiches Format wie das Blinkfeld/Scanfeld).
    let sw = v.videoWidth * 0.82;
    let sh = sw * (2 / 3);
    if (sh > v.videoHeight * 0.82) { sh = v.videoHeight * 0.82; sw = sh * 1.5; }
    const sx = (v.videoWidth - sw) / 2;
    const sy = (v.videoHeight - sh) / 2;
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, ROI_W, ROI_H);
    const img = this.ctx.getImageData(0, 0, ROI_W, ROI_H).data;
    const lum = new Float32Array(ROI_W), r = new Float32Array(ROI_W), g = new Float32Array(ROI_W), b = new Float32Array(ROI_W);
    for (let x = 0; x < ROI_W; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let y = 0; y < ROI_H; y++) {
        const i = (y * ROI_W + x) * 4;
        sr += img[i]; sg += img[i + 1]; sb += img[i + 2];
      }
      r[x] = sr / ROI_H; g[x] = sg / ROI_H; b[x] = sb / ROI_H;
      lum[x] = 0.299 * r[x] + 0.587 * g[x] + 0.114 * b[x];
    }
    return { lum, r, g, b };
  }

  _avgAround(arr, center, half) {
    const a = Math.max(0, Math.round(center - half));
    const z = Math.min(ROI_W - 1, Math.round(center + half));
    let sum = 0;
    for (let x = a; x <= z; x++) sum += arr[x];
    return sum / (z - a + 1);
  }

  _countBars(lum) {
    let min = Infinity, max = -Infinity;
    for (const v of lum) { if (v < min) min = v; if (v > max) max = v; }
    const contrast = max - min;
    if (contrast < MIN_CONTRAST) return { count: 0, contrast };
    const thr = (min + max) / 2;
    const hys = contrast * 0.15;
    const minRun = ROI_W / (MAX_BARS * 2.5);
    let runs = 0, state = null, runLen = 0;
    for (let x = 0; x < ROI_W; x++) {
      let s = state;
      if (lum[x] > thr + hys) s = 1;
      else if (lum[x] < thr - hys) s = 0;
      if (s !== state) {
        if (state !== null && runLen >= minRun) runs++;
        state = s; runLen = 0;
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
      this.fpsT = now; this.fpsN = 0;
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
    const { count, contrast } = this._countBars(prof.lum);
    this.lastContrast = contrast;
    if (count >= 2 && count <= MAX_BARS) {
      this.recentCounts.push(count);
      if (this.recentCounts.length > STABLE_FRAMES) this.recentCounts.shift();
      if (this.recentCounts.length >= STABLE_FRAMES) {
        const freq = {};
        for (const c of this.recentCounts) freq[c] = (freq[c] || 0) + 1;
        let mode = 0, modeN = 0;
        for (const c in freq) if (freq[c] > modeN) { modeN = freq[c]; mode = +c; }
        if (modeN >= STABLE_FRAMES * 0.6 && mode >= 2) this._lock(mode);
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
    const nb = bars - 1;
    this.refMin = Array.from({ length: nb }, () => [Infinity, Infinity, Infinity]);
    this.refMax = Array.from({ length: nb }, () => [-Infinity, -Infinity, -Infinity]);
    this.symbolSamples = [];
    this.lastEdge = performance.now();
    this.state = 'LOCKED';
  }

  _receive(prof, now) {
    const palette = getPalette(this.paletteId);
    const L = palette.colors.length;
    const clockLum = this._avgAround(prof.lum, this.barCenters[0], this.barHalf);

    this.clockWhite = this.clockWhite == null ? clockLum : Math.max(clockLum, this.clockWhite * 0.995 + clockLum * 0.005);
    this.clockBlack = this.clockBlack == null ? clockLum : Math.min(clockLum, this.clockBlack * 0.995 + clockLum * 0.005);
    const cContrast = this.clockWhite - this.clockBlack;
    const thr = (this.clockWhite + this.clockBlack) / 2;
    const hys = Math.max(6, cContrast * 0.2);

    // Datenbalken klassifizieren
    const values = [];
    for (let j = 1; j < this.bars; j++) {
      const rgb = [
        this._avgAround(prof.r, this.barCenters[j], this.barHalf),
        this._avgAround(prof.g, this.barCenters[j], this.barHalf),
        this._avgAround(prof.b, this.barCenters[j], this.barHalf),
      ];
      const idx = j - 1;
      for (let c = 0; c < 3; c++) {
        const mx = this.refMax[idx][c], mn = this.refMin[idx][c];
        this.refMax[idx][c] = isFinite(mx) ? Math.max(rgb[c], mx * 0.997 + rgb[c] * 0.003) : rgb[c];
        this.refMin[idx][c] = isFinite(mn) ? Math.min(rgb[c], mn * 0.997 + rgb[c] * 0.003) : rgb[c];
      }
      values.push(classifyValue(rgb, { min: this.refMin[idx], max: this.refMax[idx] }, palette));
    }
    this.symbolSamples.push(values);
    if (this.symbolSamples.length > 60) this.symbolSamples.shift();

    let cur = this.clockBin;
    if (clockLum > thr + hys) cur = 1;
    else if (clockLum < thr - hys) cur = 0;

    if (this.clockBin !== null && cur !== this.clockBin && cur !== null) {
      const dt = now - this.lastEdge;
      if (dt > 20 && dt < 2000) this.symbolPeriod = this.symbolPeriod == null ? dt : this.symbolPeriod * 0.8 + dt * 0.2;
      this._commitSymbol(palette, L);
      this.lastEdge = now;
    }
    this.clockBin = cur;

    if (now - this.lastEdge > RESEARCH_MS) {
      this.onBits(null); // Signalverlust signalisieren
      this._resetLock();
    } else this.signalLost = now - this.lastEdge > LOST_MS;
  }

  _commitSymbol(palette, L) {
    const samples = this.symbolSamples;
    if (samples.length === 0) return;
    let use = samples;
    if (samples.length >= 4) use = samples.slice(1, -1);
    const nb = this.bars - 1;
    const bpb = palette.bitsPerBar;
    const out = [];
    for (let j = 0; j < nb; j++) {
      const counts = new Array(L).fill(0);
      for (const smp of use) counts[smp[j]]++;
      let val = 0, best = -1;
      for (let v = 0; v < L; v++) if (counts[v] > best) { best = counts[v]; val = v; }
      for (let k = bpb - 1; k >= 0; k--) out.push((val >> k) & 1);
    }
    this.symbolSamples = [];
    this.onBits(out);
  }

  _emit() {
    this.onState({
      running: this.running,
      mode: this.state,
      bars: this.bars,
      dataBars: this.bars > 0 ? this.bars - 1 : 0,
      fps: this.fps,
      contrast: Math.round(this.lastContrast || 0),
      signalLost: !!this.signalLost,
      symbolPeriod: this.symbolPeriod,
    });
  }
}
