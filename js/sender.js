// sender.js — Sendemodus: Bitstrom als blinkende Balken darstellen.

export const CAL_SYMBOLS = 24; // Symbole für die Kalibrier-/Streifenphase
export const GAP_SYMBOLS = 8; // schwarze Pause zwischen zwei Durchläufen

/** Symbole pro Durchlauf für einen Bitstrom. */
export function symbolsPerLoop(bitLength, dataBars) {
  return CAL_SYMBOLS + Math.ceil(bitLength / dataBars) + GAP_SYMBOLS;
}

/** Geschätzte Dauer eines Durchlaufs in Sekunden. */
export function estimateLoopSeconds(bitLength, dataBars, symbolRate) {
  return symbolsPerLoop(bitLength, dataBars) / symbolRate;
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

  _render(clock, data) {
    this._paint(this.bars[0], clock);
    for (let j = 0; j < this.dataBars; j++) this._paint(this.bars[j + 1], data[j]);
  }

  /**
   * @param {number[]} bits Bitstrom (aus protocol.buildBitstream)
   * @param {object} opts { dataBars, symbolRate, byteLength, label }
   */
  start(bits, { dataBars, symbolRate, byteLength = 0, label = '' }) {
    this.stop();
    this.buildBars(dataBars);
    this.symbolRate = symbolRate;
    this.dataBars = dataBars;

    const dataSymbols = [];
    for (let i = 0; i < bits.length; i += dataBars) {
      const sym = [];
      for (let j = 0; j < dataBars; j++) sym.push(bits[i + j] ?? 0);
      dataSymbols.push(sym);
    }

    const totalPerLoop = CAL_SYMBOLS + dataSymbols.length + GAP_SYMBOLS;
    const loopSeconds = totalPerLoop / symbolRate;
    this.running = true;
    let k = 0;
    let loops = 0;
    let last = performance.now();
    const period = () => 1000 / this.symbolRate;

    const tick = (now) => {
      if (!this.running) return;
      if (now - last >= period()) {
        last += period();
        if (now - last > period() * 3) last = now;

        const phase = k % totalPerLoop;
        const clock = k % 2 === 1 ? 1 : 0;

        if (phase < CAL_SYMBOLS) {
          const data = [];
          for (let j = 0; j < dataBars; j++) data.push((j + k) % 2);
          this._render(clock, data);
        } else if (phase < CAL_SYMBOLS + dataSymbols.length) {
          this._render(clock, dataSymbols[phase - CAL_SYMBOLS]);
        } else {
          this.setAll(0);
        }

        if (phase === totalPerLoop - 1) loops++;
        k++;
        const inLoopSym = phase;
        this.onState({
          running: true,
          loops,
          byteLength,
          label,
          totalBars: dataBars + 1,
          loopSeconds,
          loopProgress: inLoopSym / totalPerLoop,
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
