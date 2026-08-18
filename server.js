const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));
app.use(express.json());

let sock = null;
let connectionStatus = 'disconnected';
let latestQR = null;

// --- GitHub Session Backup ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

async function saveSessionToGitHub() {
  if (!GITHUB_TOKEN) return;
  try {
    const authDir = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir);
    const sessionData = {};
    for (const file of files) {
      sessionData[file] = fs.readFileSync(path.join(authDir, file), 'utf8');
    }
    const content = Buffer.from(JSON.stringify(sessionData)).toString('base64');
    const checkRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    let sha = null;
    if (checkRes.ok) { const d = await checkRes.json(); sha = d.sha; }
    const body = { message: 'save session', content };
    if (sha) body.sha = sha;
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    console.log('Session saved to GitHub');
  } catch (e) { console.error('Save error:', e.message); }
}

async function loadSessionFromGitHub() {
  if (!GITHUB_TOKEN) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return false;
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const sessionData = JSON.parse(content);
    if (sessionData && Object.keys(sessionData).length > 0) {
      fs.mkdirSync(path.join(__dirname, 'auth_session'), { recursive: true });
      for (const [file, c] of Object.entries(sessionData)) {
        fs.writeFileSync(path.join(__dirname, 'auth_session', file), c);
      }
      console.log('Session loaded from GitHub');
      return true;
    }
    return false;
  } catch (e) { return false; }
}

if (GITHUB_TOKEN) setInterval(saveSessionToGitHub, 300000);

// --- Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: latestQR }));

app.post('/connect', async (req, res) => {
  if (sock) return res.json({ success: false, message: 'ربات در حال اجراست' });
  await startBot();
  res.json({ success: true });
});

app.post('/connect-phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'شماره را وارد کنید' });
  try {
    if (!sock) {
      await startBot();
      await new Promise(r => setTimeout(r, 3000));
    }
    if (sock) {
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(cleanPhone);
      io.emit('pairing-code', { code });
      res.json({ success: true, code });
    } else {
      res.json({ success: false, message: 'ربات آماده نیست' });
    }
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/send-message', async (req, res) => {
  const { number, message } = req.body;
  if (!sock) return res.json({ success: false, message: 'ربات متصل نیست' });
  try {
    let jid = number;
    if (!jid.includes('@')) jid = jid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/disconnect', async (req, res) => {
  if (sock) {
    try { await sock.logout(); } catch(e) {}
    sock = null;
    connectionStatus = 'disconnected';
    latestQR = null;
    io.emit('status', { status: 'disconnected' });
  }
  res.json({ success: true });
});

// --- Bot ---
async function startBot() {
  if (sock) return;
  try {
    await loadSessionFromGitHub();
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_session'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Termux Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = await qrcode.toDataURL(qr, { width: 300 });
        connectionStatus = 'waiting_qr';
        io.emit('status', { status: 'waiting_qr' });
        io.emit('qr', { qr: latestQR });
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        latestQR = null;
        io.emit('status', { status: 'connected' });
        setTimeout(saveSessionToGitHub, 5000);
        console.log('WhatsApp connected!');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = 'disconnected';
        latestQR = null;
        io.emit('status', { status: 'disconnected' });
        sock = null;
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(startBot, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const msg = messages[0];
      if (!msg.message || type !== 'notify') return;
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const msgType = Object.keys(msg.message)[0];
      let text = '';
      if (msgType === 'conversation') text = msg.message.conversation;
      else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
      else return;

      const name = msg.pushName || from;
      io.emit('incoming-message', { from, name, message: text, timestamp: new Date().toLocaleTimeString('fa-IR') });

      const lower = text.toLowerCase();
      if (lower === 'سلام' || lower === 'salam' || lower === 'hi' || lower === 'hello') {
        await sock.sendMessage(from, { text: 'سلام! 👋 چطور می‌تونم کمکت کنم؟' });
      } else if (lower === 'time' || lower === 'ساعت') {
        await sock.sendMessage(from, { text: 'ساعت ' + new Date().toLocaleTimeString('fa-IR') });
      } else if (lower === 'date' || lower === 'تاریخ') {
        await sock.sendMessage(from, { text: 'امروز ' + new Date().toLocaleDateString('fa-IR') });
      }
    });

  } catch (e) {
    console.error('Bot error:', e);
    sock = null;
  }
}

startBot();

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  Bot running on port ${PORT}`);
  console.log(`  Panel: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
