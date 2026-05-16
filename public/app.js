const socket = io();

let pc = null;
let dataChannel = null;
let roomId = null;
let filesToSend = [];
let currentFileIndex = 0;
let receivedBuffers = [];
let receivedSize = 0;
let currentFileInfo = null;

const CHUNK_SIZE = 64 * 1024; // 64KB

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  if (/\.(jpg|jpeg|png|gif|webp|heic)$/i.test(name)) return '🖼️';
  if (/\.(mp4|mov|avi|mkv|m4v)$/i.test(name)) return '🎬';
  return '📄';
}

// --- モード選択 ---
function startSend() {
  document.getElementById('mode-select').classList.add('hidden');
  document.getElementById('sender-panel').classList.remove('hidden');
  setupDropZone();
}

function startReceive() {
  document.getElementById('mode-select').classList.add('hidden');
  document.getElementById('receiver-panel').classList.remove('hidden');
}

// --- ドロップゾーン ---
function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handleFiles(Array.from(e.dataTransfer.files));
  });
  input.addEventListener('change', () => handleFiles(Array.from(input.files)));
}

function handleFiles(files) {
  filesToSend = files;
  const list = document.getElementById('file-list');
  list.innerHTML = '';
  files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-icon">${getFileIcon(f.name)}</span>
      <span>${f.name}</span>
      <span class="file-size">${formatSize(f.size)}</span>`;
    list.appendChild(item);
  });
  list.classList.remove('hidden');

  // 部屋を作る
  roomId = generateRoomId();
  socket.emit('create-room', roomId);
}

socket.on('room-created', (id) => {
  document.getElementById('room-code').textContent = id;
  document.getElementById('room-info').classList.remove('hidden');
  setStatus('sender', 'Windows側がコードを入力するのを待っています…', 'info');
});

function copyCode() {
  navigator.clipboard.writeText(roomId);
  const btn = document.querySelector('.btn-copy');
  btn.textContent = 'コピーしました！';
  setTimeout(() => btn.textContent = 'コピー', 2000);
}

// --- WebRTC 送信側 ---
socket.on('receiver-joined', async () => {
  setStatus('sender', '接続中…', 'info');
  pc = createPC('sender');
  dataChannel = pc.createDataChannel('files');
  setupDataChannelSender(dataChannel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { roomId, offer });
});

socket.on('answer', async (answer) => {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async (candidate) => {
  if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
});

// --- WebRTC 受信側 ---
async function joinRoom() {
  const code = document.getElementById('room-input').value.trim().toUpperCase();
  if (code.length !== 6) {
    setStatus('receiver', 'コードは6文字です', 'error');
    return;
  }
  roomId = code;
  socket.emit('join-room', code);
}

socket.on('joined-room', () => {
  setStatus('receiver', '接続中…', 'info');
  pc = createPC('receiver');
  pc.ondatachannel = (e) => {
    dataChannel = e.channel;
    setupDataChannelReceiver(dataChannel);
  };
});

socket.on('offer', async (offer) => {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { roomId, answer });
});

socket.on('error', (msg) => setStatus('receiver', msg, 'error'));
socket.on('peer-disconnected', () => {
  setStatus('sender', '相手が切断しました', 'error');
  setStatus('receiver', '相手が切断しました', 'error');
});

// --- RTCPeerConnection ---
function createPC(role) {
  const p = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  p.onicecandidate = (e) => {
    socket.emit('ice-candidate', { roomId, candidate: e.candidate });
  };
  return p;
}

// --- データチャンネル 送信 ---
function setupDataChannelSender(ch) {
  ch.bufferedAmountLowThreshold = 256 * 1024;
  ch.onopen = () => {
    setStatus('sender', '接続しました！送信開始します', 'success');
    sendNextFile();
  };
  ch.onclose = () => setStatus('sender', '転送完了！', 'success');
}

async function sendNextFile() {
  if (currentFileIndex >= filesToSend.length) {
    dataChannel.send(JSON.stringify({ type: 'all-done' }));
    setStatus('sender', `✅ ${filesToSend.length}件のファイルを送信しました！`, 'success');
    return;
  }

  const file = filesToSend[currentFileIndex];
  dataChannel.send(JSON.stringify({
    type: 'file-start',
    name: file.name,
    size: file.size,
    fileType: file.type,
    index: currentFileIndex,
    total: filesToSend.length
  }));

  const reader = file.stream().getReader();
  let sent = 0;

  const pump = async () => {
    while (true) {
      if (dataChannel.bufferedAmount > 1024 * 1024) {
        await new Promise(r => dataChannel.addEventListener('bufferedamountlow', r, { once: true }));
      }
      const { done, value } = await reader.read();
      if (done) break;
      dataChannel.send(value);
      sent += value.byteLength;
      updateProgress('sender', sent, file.size, currentFileIndex, filesToSend.length);
    }
    dataChannel.send(JSON.stringify({ type: 'file-end' }));
    currentFileIndex++;
    sendNextFile();
  };

  pump();
}

function updateProgress(side, sent, total, index, count) {
  const pct = Math.round((sent / total) * 100);
  const barId = side === 'sender' ? 'progress-bar' : 'progress-bar-r';
  const txtId = side === 'sender' ? 'progress-text' : 'progress-text-r';
  const wrapId = side === 'sender' ? 'progress-bar-wrap' : 'progress-bar-wrap-r';
  document.getElementById(wrapId).classList.remove('hidden');
  document.getElementById(barId).style.setProperty('--progress', pct + '%');
  document.getElementById(txtId).textContent = `${index + 1}/${count} - ${pct}%`;
}

// --- データチャンネル 受信 ---
function setupDataChannelReceiver(ch) {
  ch.onopen = () => setStatus('receiver', '接続しました！受信中…', 'info');
  ch.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'file-start') {
        currentFileInfo = msg;
        receivedBuffers = [];
        receivedSize = 0;
        setStatus('receiver', `受信中: ${msg.name} (${msg.index + 1}/${msg.total})`, 'info');
      } else if (msg.type === 'file-end') {
        saveFile();
      } else if (msg.type === 'all-done') {
        setStatus('receiver', '✅ すべてのファイルを受信しました！', 'success');
      }
    } else {
      receivedBuffers.push(e.data);
      receivedSize += e.data.byteLength;
      updateProgress('receiver', receivedSize, currentFileInfo.size,
        currentFileInfo.index, currentFileInfo.total);
    }
  };
}

function saveFile() {
  const blob = new Blob(receivedBuffers, { type: currentFileInfo.fileType });
  const url = URL.createObjectURL(blob);
  const container = document.getElementById('received-files');
  container.classList.remove('hidden');

  const item = document.createElement('div');
  item.className = 'received-file-item';
  item.innerHTML = `
    <div class="received-file-info">
      <span>${getFileIcon(currentFileInfo.name)}</span>
      <span>${currentFileInfo.name}</span>
      <span class="file-size">${formatSize(currentFileInfo.size)}</span>
    </div>
    <a class="download-btn" href="${url}" download="${currentFileInfo.name}">保存</a>
  `;
  container.appendChild(item);
}

// --- ステータス表示 ---
function setStatus(side, msg, type) {
  const id = side === 'sender' ? 'sender-status' : 'receiver-status';
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}
