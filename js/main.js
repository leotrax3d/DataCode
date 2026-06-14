// main.js — View-Routing und UI-Verdrahtung.
import { Sender, estimateLoopSeconds } from './sender.js';
import { Receiver } from './receiver.js';
import { buildTextFrame, buildFileFrame, decodePayload } from './protocol.js';

const views = {
  home: document.getElementById('view-home'),
  send: document.getElementById('view-send'),
  receive: document.getElementById('view-receive'),
};

function show(name) {
  for (const k in views) views[k].classList.toggle('active', k === name);
  if (name !== 'send') sender?.stop();
  if (name !== 'receive') receiver?.stop();
}
function route() {
  const h = location.hash.replace('#/', '') || 'home';
  show(views[h] ? h : 'home');
}
window.addEventListener('hashchange', route);

// Hilfsfunktionen --------------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtDuration(s) {
  if (!isFinite(s) || s < 0) return '–';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}

// ---------------------------------------------------------------- Sender ----
const barsEl = document.getElementById('bars');
const sender = new Sender(barsEl, { onState: renderSenderState });

const txtEl = document.getElementById('msg');
const barsCountEl = document.getElementById('barsCount');
const barsCountVal = document.getElementById('barsCountVal');
const rateEl = document.getElementById('rate');
const rateVal = document.getElementById('rateVal');
const sendStatus = document.getElementById('sendStatus');
const startSendBtn = document.getElementById('startSend');
const stopSendBtn = document.getElementById('stopSend');
const fsBtn = document.getElementById('fullscreen');
const estimateEl = document.getElementById('estimate');

// Eingabemodus Text/Datei
const tabText = document.getElementById('tabText');
const tabFile = document.getElementById('tabFile');
const paneText = document.getElementById('paneText');
const paneFile = document.getElementById('paneFile');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
let inputMode = 'text';
let selectedFile = null;

function setInputMode(m) {
  inputMode = m;
  tabText.classList.toggle('active', m === 'text');
  tabFile.classList.toggle('active', m === 'file');
  paneText.classList.toggle('hidden', m !== 'text');
  paneFile.classList.toggle('hidden', m !== 'file');
  updateEstimate();
}
tabText.addEventListener('click', () => setInputMode('text'));
tabFile.addEventListener('click', () => setInputMode('file'));

function setFile(file) {
  selectedFile = file;
  if (file) {
    fileInfo.innerHTML = `<b>${file.name}</b><br>${fmtBytes(file.size)} · ${file.type || 'unbekannter Typ'}`;
    fileInfo.classList.remove('hidden');
  } else {
    fileInfo.classList.add('hidden');
  }
  updateEstimate();
}
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files?.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) setFile(fileInput.files[0]);
});

barsCountEl.addEventListener('input', () => {
  barsCountVal.textContent = barsCountEl.value;
  updateEstimate();
});
rateEl.addEventListener('input', () => {
  rateVal.textContent = rateEl.value;
  updateEstimate();
});
txtEl.addEventListener('input', updateEstimate);

// grobe Header-/Overhead-Bits (SYNC+TYPE+LEN+CRC+END) für die Schätzung
const OVERHEAD_BITS = 16 + 8 + 32 + 32 + 16;
function payloadByteEstimate() {
  if (inputMode === 'file') return selectedFile ? selectedFile.size + 64 : 0;
  return new TextEncoder().encode(txtEl.value).length;
}
function updateEstimate() {
  const db = +barsCountEl.value;
  const rate = +rateEl.value;
  const bytes = payloadByteEstimate();
  if (bytes <= 0) {
    estimateEl.textContent = '';
    return;
  }
  const bits = OVERHEAD_BITS + bytes * 8;
  const secs = estimateLoopSeconds(bits, db, rate);
  let txt = `Geschätzte Dauer pro Durchlauf: ~${fmtDuration(secs)} (${fmtBytes(bytes)})`;
  if (secs > 120) txt += ' ⚠ Bei großen Dateien dauert die optische Übertragung sehr lange.';
  estimateEl.textContent = txt;
}

async function readFileBytes(file) {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

startSendBtn.addEventListener('click', async () => {
  try {
    const db = +barsCountEl.value;
    const rate = +rateEl.value;
    let frame, label;
    if (inputMode === 'file') {
      if (!selectedFile) {
        sendStatus.textContent = 'Bitte zuerst eine Datei auswählen.';
        return;
      }
      sendStatus.textContent = 'Datei wird gelesen …';
      const bytes = await readFileBytes(selectedFile);
      frame = buildFileFrame(selectedFile.name, selectedFile.type, bytes);
      label = `📎 ${selectedFile.name}`;
    } else {
      if (!txtEl.value) {
        sendStatus.textContent = 'Bitte zuerst einen Text eingeben.';
        return;
      }
      frame = buildTextFrame(txtEl.value);
      label = '📝 Text';
    }
    sender.start(frame.bits, { dataBars: db, symbolRate: rate, byteLength: frame.byteLength, label });
    document.getElementById('senderStage').classList.add('running');
  } catch (e) {
    sendStatus.textContent = 'Fehler: ' + e.message;
  }
});
stopSendBtn.addEventListener('click', () => {
  sender.stop();
  document.getElementById('senderStage').classList.remove('running');
});
fsBtn.addEventListener('click', () => {
  const stage = document.getElementById('senderStage');
  if (!document.fullscreenElement) stage.requestFullscreen?.();
  else document.exitFullscreen?.();
});

function renderSenderState(s) {
  if (!s.running) {
    if (s.running === false) sendStatus.textContent = 'Gestoppt.';
    return;
  }
  sendStatus.innerHTML =
    `<b>${s.phase}</b> · ${s.label} · ${s.totalBars} Balken · ${fmtBytes(s.byteLength)} · ` +
    `Durchlauf ${s.loops + 1} · ~${fmtDuration(s.loopSeconds)}/Durchlauf`;
}

// -------------------------------------------------------------- Empfänger ----
const video = document.getElementById('cam');
const receiver = new Receiver(video, { onState: renderReceiverState });

const startRecvBtn = document.getElementById('startRecv');
const stopRecvBtn = document.getElementById('stopRecv');
const rescanBtn = document.getElementById('rescan');
const recvStatus = document.getElementById('recvStatus');
const recvDebug = document.getElementById('recvDebug');
const etaLine = document.getElementById('etaLine');
const progressBar = document.getElementById('progressBar');
const progressWrap = document.getElementById('progressWrap');
const resultBox = document.getElementById('resultBox');
const resultBody = document.getElementById('resultBody');

startRecvBtn.addEventListener('click', async () => {
  recvStatus.textContent = 'Kamera wird gestartet …';
  const ok = await receiver.start();
  if (ok) {
    startRecvBtn.classList.add('hidden');
    stopRecvBtn.classList.remove('hidden');
    rescanBtn.classList.remove('hidden');
    resultBox.classList.add('hidden');
  }
});
stopRecvBtn.addEventListener('click', () => {
  receiver.stop();
  startRecvBtn.classList.remove('hidden');
  stopRecvBtn.classList.add('hidden');
  rescanBtn.classList.add('hidden');
  recvStatus.textContent = 'Gestoppt.';
});
rescanBtn.addEventListener('click', () => {
  receiver.rescan();
  resultBox.classList.add('hidden');
});

let lastSolvedKey = null;
function renderReceiverState(s) {
  if (s.error) {
    recvStatus.innerHTML = `<span class="err">⚠ ${s.error}</span>`;
    startRecvBtn.classList.remove('hidden');
    stopRecvBtn.classList.add('hidden');
    return;
  }
  if (!s.running) return;

  // ETA / Geschwindigkeit berechnen
  let etaText = '';
  if (s.symbolPeriod && s.dataBars > 0 && s.total != null && s.mode === 'LOCKED') {
    const bytesPerSec = (s.dataBars / (s.symbolPeriod / 1000)) / 8;
    const remaining = Math.max(0, s.total - (s.bytes || 0));
    const eta = remaining / bytesPerSec;
    etaText = `⏱ Rest ~${fmtDuration(eta)} · ${bytesPerSec.toFixed(1)} B/s · ${(1000 / s.symbolPeriod).toFixed(1)} Sym/s`;
  }
  etaLine.textContent = etaText;

  if (s.solved) {
    progressWrap.classList.remove('hidden');
    progressBar.style.width = '100%';
    recvStatus.innerHTML = `<span class="ok">✓ Vollständig empfangen & Prüfsumme korrekt (${fmtBytes(s.solved.byteLength)})</span>`;
    etaLine.textContent = '';
    const key = s.solved.type + ':' + s.solved.byteLength;
    if (key !== lastSolvedKey) {
      lastSolvedKey = key;
      showResult(s.solved);
      navigator.vibrate?.([120, 60, 120]);
    }
  } else if (s.mode === 'SEARCHING') {
    recvStatus.innerHTML =
      s.contrast < 28
        ? 'Balken im Rahmen ausrichten – noch kein Signal …'
        : 'Balken erkannt – zähle Balken …';
    progressWrap.classList.add('hidden');
  } else {
    if (s.signalLost) {
      recvStatus.innerHTML = '<span class="warn">Signal verloren – Kamera ruhig auf die Balken halten.</span>';
    } else if (s.progress != null) {
      progressWrap.classList.remove('hidden');
      progressBar.style.width = Math.round(s.progress * 100) + '%';
      const kind = s.candidateType === 1 ? 'Datei' : 'Text';
      recvStatus.innerHTML = `Empfange ${kind} … ${fmtBytes(s.bytes)} / ${fmtBytes(s.total)} (${Math.round(s.progress * 100)} %)`;
    } else {
      recvStatus.innerHTML = `Eingerastet auf ${s.bars} Balken – warte auf Startmarke …`;
    }
  }
  recvDebug.textContent = `Modus: ${s.mode} · Balken: ${s.bars} (${s.dataBars} Daten) · Kontrast: ${s.contrast} · ${s.fps} fps`;
}

function showResult(solved) {
  const p = decodePayload(solved.type, solved.bytes);
  resultBody.innerHTML = '';
  if (p.kind === 'text') {
    const h = document.createElement('h3');
    h.textContent = '✓ Empfangener Text';
    const pre = document.createElement('pre');
    pre.textContent = p.text;
    const copy = document.createElement('button');
    copy.textContent = '📋 Kopieren';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(p.text);
      copy.textContent = '✓ Kopiert';
      setTimeout(() => (copy.textContent = '📋 Kopieren'), 1500);
    });
    resultBody.append(h, pre, copy);
  } else {
    const h = document.createElement('h3');
    h.textContent = '✓ Empfangene Datei';
    const meta = document.createElement('p');
    meta.innerHTML = `<b>${p.name}</b> · ${fmtBytes(p.size)} · ${p.mime}`;
    const blob = new Blob([p.bytes], { type: p.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const dl = document.createElement('a');
    dl.href = url;
    dl.download = p.name || 'datei.bin';
    dl.className = 'dlbtn';
    dl.textContent = '⬇ Herunterladen';
    resultBody.append(h, meta, dl);
    if ((p.mime || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'preview';
      resultBody.append(img);
    }
  }
  resultBox.classList.remove('hidden');
}

setInputMode('text');
route();
