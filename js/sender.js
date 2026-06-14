// sender.js — Visueller Sendemodus: Bitstrom als blinkende Balken.
import { getPalette, colorCss } from './palette.js';

export const CAL_SYMBOLS = 24; // Kalibrier-/Streifenphase
export const GAP_SYMBOLS = 8; // schwarze Pause zwischen Durchläufen

const BLACK = 'rgb(0,0,0)';
const WHITE = 'rgb(255,255,255)';

export function symbolsPerLoop(bitLength, bitsPerSymbol) {
  return CAL_SYMBOLS + Math.ceil(bitLength / bitsPerSymbol) + GAP_SYMBOLS;
}
export function estimateLoopSeconds(bitLength, bitsPerSymbol, symbolRate) {
  return symbolsPerLoop(bitLength, bitsPerSymbol) / symbolRate;
}

export class Sender {
  constructor(barsEl, opts = {}) {
    this.barsEl = barsEl;
    this.onState = opts.onState || (() => {});
    this.running = false;
    this.bars = [];
    this.dataBars = 4;
    this.symbolRate = 6;
    this._raf = null;
  }

  buildBars(dataBars) {
    this.dataBars = dataBars;
    this.barsEl.innerHTML = '';
    this.bars = [];
    for (let i = 0; i < dataBars + 1; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      if (i === 0) bar.classList.add('clock');
      this.barsEl.appendChild(bar);
      this.bars.push(bar);
    }
    this.bars.forEach((b) => (b.style.background = BLACK));
  }

  _renderColors(colors) {
    for (let i = 0; i < this.bars.length; i++) this.bars[i].style.background = colors[i];
  }

  /**
   * @param {number[]} bits Bitstrom
   * @param {object} opts { dataBars, symbolRate, byteLength, label, paletteId }
   */
  start(bits, { dataBars, symbolRate, byteLength = 0, label = '', paletteId = 'bw' }) {
    this.stop();
    this.buildBars(dataBars);
    this.symbolRate = symbolRate;
    this.dataBars = dataBars;
    const palette = getPalette(paletteId);
    const bpb = palette.bitsPerBar;
    const bitsPerSymbol = dataBars * bpb;

    // Bitstrom -> Datensymbole (je dataBars Balkenwerte zu bpb Bit)
    const dataSymbols = [];
    for (let i = 0; i < bits.length; i += bitsPerSymbol) {
      const vals = [];
      for (let b = 0; b < dataBars; b++) {
        let v = 0;
        for (let k = 0; k < bpb; k++) v = (v << 1) | (bits[i + b * bpb + k] ?? 0);
        vals.push(v);
      }
      dataSymbols.push(vals);
    }

    const totalPerLoop = CAL_SYMBOLS + dataSymbols.length + GAP_SYMBOLS;
    const loopSeconds = totalPerLoop / symbolRate;
    this.running = true;
    let k = 0, loops = 0;
    let last = performance.now();
    const period = () => 1000 / this.symbolRate;

    const tick = (now) => {
      if (!this.running) return;
      if (now - last >= period()) {
        last += period();
        if (now - last > period() * 3) last = now;

        const phase = k % totalPerLoop;
        const clock = k % 2 === 1 ? WHITE : BLACK;
        const colors = new Array(dataBars + 1);
        colors[0] = clock;

        if (phase < CAL_SYMBOLS) {
          // Streifen schwarz/weiß, pro Symbol invertiert -> Balken zählbar
          for (let b = 0; b < dataBars; b++) colors[b + 1] = (b + k) % 2 ? WHITE : BLACK;
        } else if (phase < CAL_SYMBOLS + dataSymbols.length) {
          const vals = dataSymbols[phase - CAL_SYMBOLS];
          for (let b = 0; b < dataBars; b++) colors[b + 1] = colorCss(vals[b], palette);
        } else {
          for (let b = 0; b < dataBars; b++) colors[b + 1] = BLACK;
          colors[0] = BLACK;
        }
        this._renderColors(colors);

        if (phase === totalPerLoop - 1) loops++;
        k++;
        this.onState({
          running: true, loops, byteLength, label,
          totalBars: dataBars + 1, loopSeconds,
          phase: phase < CAL_SYMBOLS ? 'Kalibrierung'
            : phase < CAL_SYMBOLS + dataSymbols.length ? 'Übertragung' : 'Pause',
        });
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.onState({ running: false });
  }
}
