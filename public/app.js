let peer = null;
let conn = null;
let filesToSend = [];
let currentFileIndex = 0;
let receivedBuffers = [];
let receivedSize = 0;
let currentFileInfo = null;
let peerId = null;

const CHUNK_SIZE = 64 * 1024;

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

function startSend() {
  document.getElementById('mode-select').classList.add('hidden');
  document.getElementById('sender-panel').classList.remove('hidden');
  setupDropZone();

  peer = new Peer({ debug: 0 });
  peer.on('open', (id) => {
    peerId = id;
    document.getElementById('room-code').textContent = id;
    document.getElementById('room-info').classList.remove('hidden');
    setStatus('sender', 'Windows側がコードを入力するのを待っています…', 'info');
  });

  peer.on('connection', (c) => {
    conn = c;
    setupSenderConn();
  });

  peer.on('error', (e) => setStatus('sender', 'エラー: ' + e.message, 'error'));
}

function startReceive() {
  document.getElementById('mode-select').classList.add('hidden');
  document.getElementById('receiver-panel').classList.remove('hidden');
  peer = new Peer({ debug: 0 });
  peer.on('error', (e) => setStatus('receiver', 'エラー: ' + e.message, 'error'));
}

function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(Array.from(e.dataTransfer.files)); });
  input.addEventListener('change', () => handleFiles(Array.from(input.files)));
}

function handleFiles(files) {
  filesToSend = files;
  const list = document.getElementById('file-list');
  list.innerHTML = '';
  files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-icon">${getFileIcon(f.name)}</span><span>${f.name}</span><span class="file-size">${formatSize(f.size)}</span>`;
    list.appendChild(item);
  });
  list.classList.remove('hidden');
}

function copyCode() {
  navigator.clipboard.writeText(peerId);
  const btn = document.querySelector('.btn-copy');
  btn.textContent = 'コピーしました！';
  setTimeout(() => btn.textContent = 'コピー', 2000);
}

function joinRoom() {
  const code = document.getElementById('room-input').value.trim();
  if (!code) { setStatus('receiver', 'コードを入力してください', 'error'); return; }
  setStatus('receiver', '接続中…', 'info');
  conn = peer.connect(code, { reliable: true });
  setupReceiverConn();
}

function setupSenderConn() {
  conn.on('open', () => {
    setStatus('sender', '接続しました！送信を開始します', 'success');
    currentFileIndex = 0;
    sendNextFile();
  });
  conn.on('error', (e) => setStatus('sender', 'エラー: ' + e.message, 'error'));
  conn.on('close', () => setStatus('sender', '転送完了！接続が閉じました', 'info'));
}

async function sendNextFile() {
  if (currentFileIndex >= filesToSend.length) {
    conn.send({ type: 'all-done' });
    setStatus('sender', `✅ ${filesToSend.length}件のファイルを送信しました！`, 'success');
    return;
  }

  const file = filesToSend[currentFileIndex];
  conn.send({ type: 'file-start', name: file.name, size: file.size, fileType: file.type, index: currentFileIndex, total: filesToSend.length });

  const buffer = await file.arrayBuffer();
  let offset = 0;
  while (offset < buffer.byteLength) {
    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
    conn.send(chunk);
    offset += chunk.byteLength;
    updateProgress('sender', offset, buffer.byteLength, currentFileIndex, filesToSend.length);
    await new Promise(r => setTimeout(r, 10));
  }

  conn.send({ type: 'file-end' });
  currentFileIndex++;
  sendNextFile();
}

function setupReceiverConn() {
  conn.on('open', () => setStatus('receiver', '接続しました！受信待機中…', 'success'));
  conn.on('data', (data) => {
    if (data instanceof ArrayBuffer) {
      receivedBuffers.push(data);
      receivedSize += data.byteLength;
      if (currentFileInfo) updateProgress('receiver', receivedSize, currentFileInfo.size, currentFileInfo.index, currentFileInfo.total);
    } else if (typeof data === 'object') {
      if (data.type === 'file-start') {
        currentFileInfo = data;
        receivedBuffers = [];
        receivedSize = 0;
        setStatus('receiver', `受信中: ${data.name} (${data.index + 1}/${data.total})`, 'info');
      } else if (data.type === 'file-end') {
        saveFile();
      } else if (data.type === 'all-done') {
        setStatus('receiver', '✅ すべてのファイルを受信しました！', 'success');
      }
    }
  });
  conn.on('error', (e) => setStatus('receiver', 'エラー: ' + e.message, 'error'));
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

function updateProgress(side, sent, total, index, count) {
  const pct = Math.round((sent / total) * 100);
  const barId = side === 'sender' ? 'progress-bar' : 'progress-bar-r';
  const txtId = side === 'sender' ? 'progress-text' : 'progress-text-r';
  const wrapId = side === 'sender' ? 'progress-bar-wrap' : 'progress-bar-wrap-r';
  document.getElementById(wrapId).classList.remove('hidden');
  document.getElementById(barId).style.setProperty('--progress', pct + '%');
  document.getElementById(txtId).textContent = `${index + 1}/${count} - ${pct}%`;
}

function setStatus(side, msg, type) {
  const id = side === 'sender' ? 'sender-status' : 'receiver-status';
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}
