// palette.js — optionale Mehrstufen-/Farbübertragung (mehr Bits pro Balken).
// Bei Schwarz/Weiß trägt jeder Balken 1 Bit; mit Graustufen/Farben mehr.
// Muss bei Sender UND Empfänger gleich eingestellt sein.

export const PALETTES = {
  bw: {
    name: 'Schwarz/Weiß (1 Bit/Balken)',
    bitsPerBar: 1,
    gray: true,
    colors: [[0, 0, 0], [255, 255, 255]],
  },
  gray4: {
    name: '4 Graustufen (2 Bit/Balken)',
    bitsPerBar: 2,
    gray: true,
    colors: [[0, 0, 0], [90, 90, 90], [175, 175, 175], [255, 255, 255]],
  },
  color8: {
    name: '8 Farben (3 Bit/Balken)',
    bitsPerBar: 3,
    gray: false,
    colors: [
      [0, 0, 0], [255, 255, 255], [235, 45, 45], [45, 215, 45],
      [60, 95, 255], [240, 230, 45], [45, 220, 220], [235, 60, 235],
    ],
  },
};

export function getPalette(id) {
  return PALETTES[id] || PALETTES.bw;
}

/** CSS-Farbe für einen Balkenwert. */
export function colorCss(value, palette) {
  const c = palette.colors[value] || palette.colors[0];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Klassifiziert einen gemessenen Balken (r,g,b) zu einem Palettenwert.
 * @param {number[]} rgb gemessene Mittelwerte 0..255
 * @param {object} ref  { min:[r,g,b], max:[r,g,b] } pro Balken nachgeführt
 * @param {object} palette
 * @returns {number} Wert 0..levels-1
 */
export function classifyValue(rgb, ref, palette) {
  const norm = (v, lo, hi) => (hi - lo > 1 ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0);
  if (palette.gray) {
    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const loL = 0.299 * ref.min[0] + 0.587 * ref.min[1] + 0.114 * ref.min[2];
    const hiL = 0.299 * ref.max[0] + 0.587 * ref.max[1] + 0.114 * ref.max[2];
    const n = norm(lum, loL, hiL);
    const L = palette.colors.length;
    let best = 0, bd = Infinity;
    for (let v = 0; v < L; v++) {
      const target = v / (L - 1);
      const d = Math.abs(n - target);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  // Farbe: pro Kanal weißabgleichen, dann nächstgelegene Palettenfarbe
  const n = [norm(rgb[0], ref.min[0], ref.max[0]), norm(rgb[1], ref.min[1], ref.max[1]), norm(rgb[2], ref.min[2], ref.max[2])];
  let best = 0, bd = Infinity;
  for (let v = 0; v < palette.colors.length; v++) {
    const c = palette.colors[v];
    const cn = [c[0] / 255, c[1] / 255, c[2] / 255];
    const d = (n[0] - cn[0]) ** 2 + (n[1] - cn[1]) ** 2 + (n[2] - cn[2]) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
