// sender.js — Sendemodus: Daten als blinkende Balken darstellen.
import { buildBitstream } from './protocol.js';

const CAL_SYMBOLS = 24; // Symbole für die Kalibrier-/Streifenphase
const GAP_SYMBOLS = 8; // schwarze Pause zwischen zwei Durchläufen

export class Sender {
  /**
   * @param {HTMLElement} barsEl  Container für die Balken
   * @param {object} opts { onState }
   */
  constructor(barsEl, opts = {}) {
    this.barsEl = barsEl;
    this.onState = opts.onState || (() => {});
    this.running = false;
    this.bars = []; // DOM-Elemente
    this.dataBars = 4;
    this.symbolRate = 6;
    this._raf = null;
  }

  buildBars(dataBars) {
    this.dataBars = dataBars;
    this.barsEl.innerHTML = '';
    this.bars = [];
    const total = dataBars + 1; // + Takt-Balken
    for (let i = 0; i < total; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      if (i === 0) bar.classList.add('clock');
      this.barsEl.appendChild(bar);
      this.bars.push(bar);
    }
    this.setAll(0);
  }

  setAll(v) {
    for (const bar of this.bars) this._paint(bar, v);
  }

  _paint(bar, v) {
    bar.classList.toggle('white', v === 1);
    bar.classList.toggle('black', v !== 1);
  }

  /** Zeigt ein Symbol an: Takt (links) + Datenbalken. */
  _render(clock, data) {
    this._paint(this.bars[0], clock);
    for (let j = 0; j < this.dataBars; j++) {
      this._paint(this.bars[j + 1], data[j]);
    }
  }

  start(text, { dataBars, symbolRate }) {
    this.stop();
    this.buildBars(dataBars);
    this.symbolRate = symbolRate;

    const { bits, byteLength, crc } = buildBitstream(text);
    this.dataBars = dataBars;

    // Bits in Symbole zerlegen (je dataBars Bits, MSB = linker Datenbalken).
    const dataSymbols = [];
    for (let i = 0; i < bits.length; i += dataBars) {
      const sym = [];
      for (let j = 0; j < dataBars; j++) sym.push(bits[i + j] ?? 0);
      dataSymbols.push(sym);
    }

    const totalPerLoop = CAL_SYMBOLS + dataSymbols.length + GAP_SYMBOLS;
    this.running = true;
    let k = 0; // globaler Symbolzähler (für kontinuierlichen Takt)
    let loops = 0;
    let last = performance.now();
    const period = () => 1000 / this.symbolRate;

    const tick = (now) => {
      if (!this.running) return;
      if (now - last >= period()) {
        last += period();
        if (now - last > period() * 3) last = now; // Drift abfangen

        const phase = k % totalPerLoop;
        const clock = (k % 2) === 1 ? 1 : 0;

        if (phase < CAL_SYMBOLS) {
          // Streifenmuster, das pro Symbol invertiert -> Balken zählbar.
          const data = [];
          for (let j = 0; j < dataBars; j++) data.push((j + k) % 2);
          this._render(clock, data);
        } else if (phase < CAL_SYMBOLS + dataSymbols.length) {
          this._render(clock, dataSymbols[phase - CAL_SYMBOLS]);
        } else {
          this.setAll(0); // schwarze Pause = Loop-Trenner
        }

        if (phase === totalPerLoop - 1) loops++;
        k++;
        this.onState({
          running: true,
          loops,
          byteLength,
          crc,
          totalBars: dataBars + 1,
          phase:
            phase < CAL_SYMBOLS
              ? 'Kalibrierung'
              : phase < CAL_SYMBOLS + dataSymbols.length
                ? 'Übertragung'
                : 'Pause',
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
