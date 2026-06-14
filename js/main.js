// main.js — Routing & UI für visuelle und Audio-Übertragung.
import { Sender, estimateLoopSeconds } from './sender.js';
import { Receiver } from './receiver.js';
import { AudioSender, AudioReceiver, AUDIO } from './audio.js';
import { buildTextFrame, buildFileFrame, decodePayload, Decoder } from './protocol.js';
import { getPalette } from './palette.js';

const VIEWS = ['home', 'send', 'receive', 'asend', 'areceive'];
const views = {};
for (const v of VIEWS) views[v] = document.getElementById('view-' + v);

function show(name) {
  for (const v of VIEWS) views[v].classList.toggle('active', v === name);
  if (name !== 'send') sender.stop();
  if (name !== 'receive') receiver.stop();
  if (name !== 'asend') audioSender.stop();
  if (name !== 'areceive') audioReceiver.stop();
}
function route() {
  const h = location.hash.replace('#/', '') || 'home';
  show(views[h] ? h : 'home');
}
window.addEventListener('hashchange', route);

// Hilfen -----------------------------------------------------------------
function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtDuration(s) {
  if (!isFinite(s) || s < 0) return '–';
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}
async function fileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}
const $ = (id) => document.getElementById(id);

// Wiederverwendbarer Text/Datei-Eingabebaustein --------------------------
function makeInput(prefix, onChange) {
  const tabText = $(prefix + 'TabText'), tabFile = $(prefix + 'TabFile');
  const paneText = $(prefix + 'PaneText'), paneFile = $(prefix + 'PaneFile');
  const msg = $(prefix + 'Msg'), dz = $(prefix + 'Dropzone'), fi = $(prefix + 'FileInput'), info = $(prefix + 'FileInfo');
  const state = { mode: 'text', file: null };
  const setMode = (m) => {
    state.mode = m;
    tabText.classList.toggle('active', m === 'text');
    tabFile.classList.toggle('active', m === 'file');
    paneText.classList.toggle('hidden', m !== 'text');
    paneFile.classList.toggle('hidden', m !== 'file');
    onChange();
  };
  tabText.addEventListener('click', () => setMode('text'));
  tabFile.addEventListener('click', () => setMode('file'));
  const setFile = (f) => {
    state.file = f;
    if (f) { info.innerHTML = `<b>${f.name}</b><br>${fmtBytes(f.size)} · ${f.type || 'unbekannter Typ'}`; info.classList.remove('hidden'); }
    else info.classList.add('hidden');
    onChange();
  };
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files?.length) setFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', () => { if (fi.files?.length) setFile(fi.files[0]); });
  msg.addEventListener('input', onChange);

  return {
    state,
    /** geschätzte Nutzbyte-Anzahl (für Dauer-Schätzung) */
    payloadBytes() {
      if (state.mode === 'file') return state.file ? state.file.size + 64 : 0;
      return new TextEncoder().encode(msg.value).length;
    },
    /** baut den Frame; gibt null bei leerer Eingabe */
    async buildFrame(parity) {
      if (state.mode === 'file') {
        if (!state.file) return null;
        const b = await fileBytes(state.file);
        return { ...buildFileFrame(state.file.name, state.file.type, b, parity), label: 'Datei: ' + state.file.name };
      }
      if (!msg.value) return null;
      return { ...buildTextFrame(msg.value, parity), label: 'Text' };
    },
  };
}

// Gemeinsame Ergebnis-/Fortschrittsanzeige -------------------------------
function makeResultUI(prefix) {
  return {
    status: $(prefix + 'Status'),
    wrap: $(prefix + 'ProgressWrap'),
    bar: $(prefix + 'ProgressBar'),
    eta: $(prefix + 'Eta'),
    box: $(prefix + 'ResultBox'),
    body: $(prefix + 'ResultBody'),
    lastKey: null,
  };
}
function renderResult(ui, solved) {
  const key = solved.type + ':' + solved.byteLength;
  if (key === ui.lastKey) return;
  ui.lastKey = key;
  const p = decodePayload(solved.type, solved.bytes);
  ui.body.innerHTML = '';
  if (p.kind === 'text') {
    const h = document.createElement('h3'); h.textContent = 'Empfangener Text';
    const pre = document.createElement('pre'); pre.textContent = p.text;
    const copy = document.createElement('button'); copy.textContent = 'Kopieren';
    copy.onclick = () => { navigator.clipboard?.writeText(p.text); copy.textContent = 'Kopiert'; setTimeout(() => (copy.textContent = 'Kopieren'), 1500); };
    ui.body.append(h, pre, copy);
  } else {
    const h = document.createElement('h3'); h.textContent = 'Empfangene Datei';
    const meta = document.createElement('p'); meta.innerHTML = `<b>${p.name}</b> · ${fmtBytes(p.size)} · ${p.mime}`;
    const blob = new Blob([p.bytes], { type: p.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const dl = document.createElement('a'); dl.href = url; dl.download = p.name || 'datei.bin'; dl.className = 'dlbtn'; dl.textContent = 'Herunterladen';
    ui.body.append(h, meta, dl);
    if ((p.mime || '').startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.className = 'preview'; ui.body.append(img); }
  }
  ui.box.classList.remove('hidden');
  ui.box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  navigator.vibrate?.([120, 60, 120]);
}
/** Aktualisiert Fortschritt + Restzeit aus Decoder-Zustand. */
function renderDecode(ui, decoder, bitsPerSymbol, symbolPeriodMs, idleText) {
  if (decoder.solved) {
    ui.wrap.classList.remove('hidden'); ui.bar.style.width = '100%'; ui.eta.textContent = '';
    ui.status.innerHTML = `<span class="ok">Vollständig empfangen — Prüfsumme korrekt (${fmtBytes(decoder.solved.byteLength)})</span>`;
    renderResult(ui, decoder.solved);
    return;
  }
  const c = decoder.candidate;
  if (c && c.codedLen) {
    ui.wrap.classList.remove('hidden');
    const prog = c.codedLen ? c.receivedCoded / c.codedLen : 0;
    ui.bar.style.width = Math.round(prog * 100) + '%';
    ui.status.innerHTML = `Empfange … ${Math.round(prog * 100)} %` + (c.parity ? ' · Fehlerkorrektur aktiv' : '');
    if (symbolPeriodMs && bitsPerSymbol) {
      const bps = bitsPerSymbol / (symbolPeriodMs / 1000);
      const eta = ((c.codedLen - c.receivedCoded) * 8) / bps;
      ui.eta.textContent = `Rest ~${fmtDuration(eta)} · ${(bps / 8).toFixed(1)} B/s`;
    }
  } else {
    ui.wrap.classList.add('hidden'); ui.eta.textContent = '';
    if (idleText) ui.status.textContent = idleText;
  }
}

// =================================================== Visueller Sender ====
const sender = new Sender($('bars'), { onState: renderSenderState });
const sndInput = makeInput('snd', updateSendEstimate);
const OVERHEAD_BITS = (16 + 8 + 32 + 16) + 9 * 8; // grobe Schätzung inkl. msg-Header

function visualBitsPerSymbol() {
  return +$('barsCount').value * getPalette($('paletteSel').value).bitsPerBar;
}
function updateSendEstimate() {
  const bytes = sndInput.payloadBytes();
  if (bytes <= 0) { $('estimate').textContent = ''; return; }
  const bits = OVERHEAD_BITS + bytes * 8 * (1 + (+$('fecSel').value) / 32);
  const secs = estimateLoopSeconds(bits, visualBitsPerSymbol(), +$('rate').value);
  let t = `Geschätzte Dauer pro Durchlauf: ~${fmtDuration(secs)} (${fmtBytes(bytes)})`;
  if (secs > 120) t += ' — große Datenmenge, dauert lange.';
  $('estimate').textContent = t;
}
['barsCount', 'rate', 'paletteSel', 'fecSel'].forEach((id) => $(id).addEventListener('input', () => {
  if (id === 'barsCount') $('barsCountVal').textContent = $(id).value;
  if (id === 'rate') $('rateVal').textContent = $(id).value;
  updateSendEstimate();
}));

// Größe des Blinkfelds
const stageSize = $('stageSize');
function applyStageSize() { $('senderStage').style.setProperty('--stage-w', stageSize.value + '%'); }
stageSize.addEventListener('input', applyStageSize);

$('startSend').addEventListener('click', async () => {
  try {
    const parity = +$('fecSel').value;
    const frame = await sndInput.buildFrame(parity);
    if (!frame) { $('sendStatus').textContent = 'Bitte Text eingeben oder Datei wählen.'; return; }
    sender.start(frame.bits, {
      dataBars: +$('barsCount').value, symbolRate: +$('rate').value,
      byteLength: frame.byteLength, label: frame.label, paletteId: $('paletteSel').value,
    });
    $('senderStage').classList.add('running');
  } catch (e) { $('sendStatus').textContent = 'Fehler: ' + e.message; }
});
$('stopSend').addEventListener('click', () => { sender.stop(); $('senderStage').classList.remove('running'); });
$('fullscreen').addEventListener('click', () => {
  const s = $('senderStage');
  if (!document.fullscreenElement) s.requestFullscreen?.(); else document.exitFullscreen?.();
});
function renderSenderState(s) {
  if (!s.running) { if (s.running === false) $('sendStatus').textContent = 'Gestoppt.'; return; }
  $('sendStatus').innerHTML = `<b>${s.phase}</b> · ${s.label} · ${s.totalBars} Balken · ${fmtBytes(s.byteLength)} · Durchlauf ${s.loops + 1} · ~${fmtDuration(s.loopSeconds)}/Durchlauf`;
}

// =================================================== Visueller Empfänger =
const recvDecoder = new Decoder();
const recvUI = makeResultUI('recv');
const receiver = new Receiver($('cam'), {
  onState: renderReceiverState,
  onBits: (bits) => { if (bits === null) recvDecoder.softReset(); else recvDecoder.append(bits); },
});
$('paletteSelR').addEventListener('change', () => receiver.setPalette($('paletteSelR').value));
$('startRecv').addEventListener('click', async () => {
  recvUI.status.textContent = 'Kamera wird gestartet …';
  receiver.setPalette($('paletteSelR').value);
  recvDecoder.reset(); recvUI.lastKey = null; recvUI.box.classList.add('hidden');
  if (await receiver.start()) { $('startRecv').classList.add('hidden'); $('stopRecv').classList.remove('hidden'); $('rescan').classList.remove('hidden'); }
});
$('stopRecv').addEventListener('click', () => { receiver.stop(); $('startRecv').classList.remove('hidden'); $('stopRecv').classList.add('hidden'); $('rescan').classList.add('hidden'); recvUI.status.textContent = 'Gestoppt.'; });
$('rescan').addEventListener('click', () => { receiver.rescan(); recvDecoder.reset(); recvUI.lastKey = null; recvUI.box.classList.add('hidden'); });

function renderReceiverState(s) {
  if (s.error) { recvUI.status.innerHTML = `<span class="err">${s.error}</span>`; $('startRecv').classList.remove('hidden'); $('stopRecv').classList.add('hidden'); return; }
  if (!s.running) return;
  // Bei Erfolg Kamera automatisch stoppen (klarer Abschluss).
  if (recvDecoder.solved && receiver.running) {
    receiver.stop();
    $('startRecv').classList.remove('hidden'); $('stopRecv').classList.add('hidden'); $('rescan').classList.remove('hidden');
  }
  const bpb = getPalette($('paletteSelR').value).bitsPerBar;
  const bitsPerSymbol = (s.dataBars || 0) * bpb;
  if (!recvDecoder.solved && s.mode === 'SEARCHING') {
    recvUI.status.textContent = s.contrast < 28 ? 'Balken im Rahmen ausrichten – noch kein Signal …' : 'Balken erkannt – zähle …';
    recvUI.wrap.classList.add('hidden'); recvUI.eta.textContent = '';
  } else if (!recvDecoder.solved && s.signalLost) {
    recvUI.status.innerHTML = '<span class="warn">Signal verloren – Kamera ruhig halten.</span>';
  } else {
    renderDecode(recvUI, recvDecoder, bitsPerSymbol, s.symbolPeriod, `Eingerastet auf ${s.bars} Balken – warte …`);
  }
  $('recvDebug').textContent = `Modus: ${s.mode} · Balken: ${s.bars} (${s.dataBars} Daten) · Kontrast: ${s.contrast} · ${s.fps} fps`;
}

// ======================================================= Audio-Sender ====
const audioSender = new AudioSender({ onState: renderAudioSendState });
const asndInput = makeInput('asnd', updateAudioEstimate);
const SYM_PRESETS = { langsam: 0.09, mittel: 0.06, schnell: 0.04 };
function audioSymbolSec() { return SYM_PRESETS[$('aRate').value] || 0.06; }
function updateAudioEstimate() {
  const bytes = asndInput.payloadBytes();
  if (bytes <= 0) { $('aEstimate').textContent = ''; return; }
  const bits = OVERHEAD_BITS + bytes * 8 * (1 + (+$('aFecSel').value) / 32);
  const syms = bits / AUDIO.BITS_PER_SYM + 14;
  const secs = syms * audioSymbolSec() + 0.4;
  let t = `Geschätzte Dauer pro Durchlauf: ~${fmtDuration(secs)} (${fmtBytes(bytes)})`;
  if (secs > 120) t += ' — dauert lange.';
  $('aEstimate').textContent = t;
}
['aRate', 'aFecSel'].forEach((id) => $(id).addEventListener('change', updateAudioEstimate));
$('aStartSend').addEventListener('click', async () => {
  try {
    const frame = await asndInput.buildFrame(+$('aFecSel').value);
    if (!frame) { $('aSendStatus').textContent = 'Bitte Text eingeben oder Datei wählen.'; return; }
    audioSender.start(frame.bits, { symbolSec: audioSymbolSec() });
    $('aSendStatus').dataset.label = frame.label;
    $('aSendStatus').dataset.bytes = frame.byteLength;
  } catch (e) { $('aSendStatus').textContent = 'Fehler: ' + e.message; }
});
$('aStopSend').addEventListener('click', () => audioSender.stop());
function renderAudioSendState(s) {
  if (!s.running) { if (s.running === false) $('aSendStatus').textContent = 'Gestoppt.'; return; }
  const st = $('aSendStatus');
  st.innerHTML = `Sende Töne · ${st.dataset.label || ''} · ${fmtBytes(+st.dataset.bytes || 0)} · Durchlauf ${s.loops} · ~${fmtDuration(s.loopSec)}/Durchlauf`;
}

// ===================================================== Audio-Empfänger ===
const aDecoder = new Decoder();
const arecvUI = makeResultUI('arecv');
let aSymbolSec = 0.06;
const audioReceiver = new AudioReceiver({
  onSymbols: (bits) => aDecoder.append(bits),
  onState: renderAudioRecvState,
});
$('aStartRecv').addEventListener('click', async () => {
  arecvUI.status.textContent = 'Mikrofon wird gestartet …';
  aSymbolSec = SYM_PRESETS[$('aRateR').value] || 0.06;
  aDecoder.reset(); arecvUI.lastKey = null; arecvUI.box.classList.add('hidden');
  if (await audioReceiver.start({ symbolSec: aSymbolSec })) { $('aStartRecv').classList.add('hidden'); $('aStopRecv').classList.remove('hidden'); }
});
$('aStopRecv').addEventListener('click', () => { audioReceiver.stop(); $('aStartRecv').classList.remove('hidden'); $('aStopRecv').classList.add('hidden'); arecvUI.status.textContent = 'Gestoppt.'; });
function renderAudioRecvState(s) {
  if (s.error) { arecvUI.status.innerHTML = `<span class="err">${s.error}</span>`; $('aStartRecv').classList.remove('hidden'); $('aStopRecv').classList.add('hidden'); return; }
  if (!s.running) return;
  if (aDecoder.solved && audioReceiver.running) {
    audioReceiver.stop();
    $('aStartRecv').classList.remove('hidden'); $('aStopRecv').classList.add('hidden');
  }
  if (!aDecoder.solved && !aDecoder.candidate) {
    arecvUI.status.textContent = s.state === 'receiving' ? 'Töne erkannt – empfange …' : 'Höre … Töne abspielen lassen.';
    arecvUI.wrap.classList.add('hidden');
  } else {
    renderDecode(arecvUI, aDecoder, AUDIO.BITS_PER_SYM, aSymbolSec * 1000, 'Höre …');
  }
  $('aRecvDebug').textContent = `Status: ${s.state || '–'} · Pegel: ${(s.level || 0).toFixed(3)} · Symbole: ${s.symCount || 0}`;
}

// Init
applyStageSize();
updateSendEstimate();
updateAudioEstimate();
route();
