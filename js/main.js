// main.js — View-Routing und UI-Verdrahtung.
import { Sender } from './sender.js';
import { Receiver } from './receiver.js';

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

barsCountEl.addEventListener('input', () => (barsCountVal.textContent = barsCountEl.value));
rateEl.addEventListener('input', () => (rateVal.textContent = rateEl.value));

startSendBtn.addEventListener('click', () => {
  const text = txtEl.value;
  if (!text) {
    sendStatus.textContent = 'Bitte zuerst einen Text eingeben.';
    return;
  }
  try {
    sender.start(text, { dataBars: +barsCountEl.value, symbolRate: +rateEl.value });
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
    `<b>${s.phase}</b> · ${s.totalBars} Balken (1 Takt + ${s.totalBars - 1} Daten) · ` +
    `${s.byteLength} Bytes · CRC 0x${s.crc.toString(16).toUpperCase().padStart(4, '0')} · ` +
    `Durchlauf ${s.loops + 1}`;
}

// -------------------------------------------------------------- Empfänger ----
const video = document.getElementById('cam');
const receiver = new Receiver(video, { onState: renderReceiverState });

const startRecvBtn = document.getElementById('startRecv');
const stopRecvBtn = document.getElementById('stopRecv');
const rescanBtn = document.getElementById('rescan');
const recvStatus = document.getElementById('recvStatus');
const recvDebug = document.getElementById('recvDebug');
const progressBar = document.getElementById('progressBar');
const progressWrap = document.getElementById('progressWrap');
const resultBox = document.getElementById('resultBox');
const resultText = document.getElementById('resultText');

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

let lastSolvedText = null;
function renderReceiverState(s) {
  if (s.error) {
    recvStatus.innerHTML = `<span class="err">⚠ ${s.error}</span>`;
    startRecvBtn.classList.remove('hidden');
    stopRecvBtn.classList.add('hidden');
    return;
  }
  if (!s.running) return;

  if (s.solved) {
    progressWrap.classList.remove('hidden');
    progressBar.style.width = '100%';
    recvStatus.innerHTML = `<span class="ok">✓ Nachricht vollständig & Prüfsumme korrekt (${s.solved.byteLength} Bytes)</span>`;
    if (s.solved.text !== lastSolvedText) {
      lastSolvedText = s.solved.text;
      resultText.textContent = s.solved.text;
      resultBox.classList.remove('hidden');
      navigator.vibrate?.([120, 60, 120]);
    }
  } else if (s.mode === 'SEARCHING') {
    recvStatus.innerHTML = s.contrast < 28
      ? 'Balken im Rahmen ausrichten – noch kein Signal …'
      : 'Balken erkannt – zähle Balken …';
    progressWrap.classList.add('hidden');
  } else {
    // LOCKED
    if (s.signalLost) {
      recvStatus.innerHTML = '<span class="warn">Signal verloren – Kamera ruhig auf die Balken halten.</span>';
    } else if (s.progress != null) {
      progressWrap.classList.remove('hidden');
      progressBar.style.width = Math.round(s.progress * 100) + '%';
      recvStatus.innerHTML = `Empfange … ${s.bytes}/${s.total} Bytes (${Math.round(s.progress * 100)} %)`;
    } else {
      recvStatus.innerHTML = `Eingerastet auf ${s.bars} Balken – warte auf Startmarke …`;
    }
  }
  recvDebug.textContent =
    `Modus: ${s.mode} · Balken: ${s.bars} (${s.dataBars} Daten) · Kontrast: ${s.contrast} · ${s.fps} fps`;
}

route();
