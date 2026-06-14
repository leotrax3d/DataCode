// rs.js — Reed-Solomon-Fehlerkorrektur über GF(2^8).
// Portierung der bekannten "Reed-Solomon for coders"-Referenz nach JS.
// Korrigiert bis zu floor(nsym/2) fehlerhafte Bytes pro Block.
// Primitivpolynom 0x11d (x^8+x^4+x^3+x^2+1), Generator alpha = 2.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
const pow = (a, n) => EXP[(LOG[a] * n) % 255];
const inv = (a) => EXP[255 - LOG[a]];

function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function generatorPoly(nsym) {
  let g = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.of(1, pow(2, i)));
  return g;
}

/** Systematische RS-Kodierung: hängt nsym Paritäts-Bytes an msg an. */
export function rsEncode(msg, nsym) {
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg, 0);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
  }
  out.set(msg, 0); // systematischer Teil bleibt die Originalnachricht
  return out;
}

function calcSyndromes(msg, nsym) {
  const synd = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) synd[i + 1] = polyEval(msg, pow(2, i));
  return synd;
}

function findErrorLocator(synd, nsym) {
  let errLoc = Uint8Array.of(1);
  let oldLoc = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) {
    const K = i + 1;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    // oldLoc um eine Stelle verschieben (mit 0 anhängen)
    const shifted = new Uint8Array(oldLoc.length + 1);
    shifted.set(oldLoc, 0);
    oldLoc = shifted;
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        let newLoc = oldLoc.map((c) => mul(c, delta));
        oldLoc = errLoc.map((c) => mul(c, inv(delta)));
        errLoc = newLoc;
      }
      const scaled = oldLoc.map((c) => mul(c, delta));
      const res = new Uint8Array(Math.max(errLoc.length, scaled.length));
      const off1 = res.length - errLoc.length;
      const off2 = res.length - scaled.length;
      for (let j = 0; j < errLoc.length; j++) res[off1 + j] = errLoc[j];
      for (let j = 0; j < scaled.length; j++) res[off2 + j] ^= scaled[j];
      errLoc = res;
    }
  }
  // führende Nullen entfernen
  let start = 0;
  while (start < errLoc.length - 1 && errLoc[start] === 0) start++;
  errLoc = errLoc.slice(start);
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null; // zu viele Fehler
  return errLoc;
}

function findErrors(errLoc, nmess) {
  const errs = errLoc.length - 1;
  const positions = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLoc, pow(2, i)) === 0) positions.push(nmess - 1 - i);
  }
  if (positions.length !== errs) return null;
  return positions;
}

/** Löst A·x = b in GF(256) per Gauß-Elimination. */
function gfSolve(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) if (A[r][col] !== 0) { piv = r; break; }
    if (piv < 0) return null;
    if (piv !== col) {
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
    }
    const invP = inv(A[col][col]);
    for (let c = col; c < n; c++) A[col][c] = mul(A[col][c], invP);
    b[col] = mul(b[col], invP);
    for (let r = 0; r < n; r++) {
      if (r === col || A[r][col] === 0) continue;
      const f = A[r][col];
      for (let c = col; c < n; c++) A[r][c] ^= mul(f, A[col][c]);
      b[r] ^= mul(f, b[col]);
    }
  }
  return b;
}

/**
 * Bestimmt die Fehlerwerte bei bekannten Positionen direkt aus den Syndromen.
 * Es gilt S_i = Σ_k e_k · X_k^i mit X_k = alpha^(nmess-1-pos_k); das ist ein
 * lineares (Vandermonde-)Gleichungssystem, das wir exakt lösen.
 */
function correctErrata(msg, synd, positions) {
  const t = positions.length;
  if (t === 0) return Uint8Array.from(msg);
  const nmess = msg.length;
  const X = positions.map((p) => pow(2, nmess - 1 - p));
  const A = [];
  const b = [];
  for (let i = 0; i < t; i++) {
    const row = new Array(t);
    for (let k = 0; k < t; k++) row[k] = pow(X[k], i);
    A.push(row);
    b.push(synd[i + 1]);
  }
  const e = gfSolve(A, b, t);
  if (!e) return null;
  const out = Uint8Array.from(msg);
  for (let i = 0; i < t; i++) out[positions[i]] ^= e[i];
  return out;
}

/**
 * RS-Dekodierung eines Blocks (data+parity = nmess Bytes).
 * @returns {Uint8Array|null} die korrigierte Gesamtnachricht oder null.
 */
export function rsDecode(msg, nsym) {
  const synd = calcSyndromes(msg, nsym);
  let allZero = true;
  for (let i = 1; i < synd.length; i++) if (synd[i] !== 0) { allZero = false; break; }
  if (allZero) return Uint8Array.from(msg);

  const errLoc = findErrorLocator(synd, nsym);
  if (!errLoc) return null;
  const positions = findErrors(Uint8Array.from(errLoc).reverse(), msg.length);
  if (!positions) return null;
  const corrected = correctErrata(msg, synd, positions);
  if (!corrected) return null;
  // Verifikation: Syndrome müssen nun null sein
  const synd2 = calcSyndromes(corrected, nsym);
  for (let i = 1; i < synd2.length; i++) if (synd2[i] !== 0) return null;
  return corrected;
}
