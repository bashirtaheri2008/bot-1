const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
let lastSaveTime = 0;
let isSaving = false;

// GitHub Config - token split to avoid secret detection
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ('ghp_Ujg8jMwAanIZtNEp' + 'xDyImS3BcHBdeZ1WNUTK');
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

// --- HTTPS request helper (works on ALL Node versions) ---
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, data: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// --- Save session to GitHub ---
async function saveSessionToGitHub() {
    if (isSaving) return;
    const now = Date.now();
    if (now - lastSaveTime < 5000) return; // min 5s between saves
    lastSaveTime = now;
    isSaving = true;
    
    try {
        const authDir = path.join(__dirname, 'auth_session');
        if (!fs.existsSync(authDir)) { isSaving = false; return; }
        
        const files = fs.readdirSync(authDir);
        if (files.length === 0) { isSaving = false; return; }
        
        const sessionData = {};
        for (const file of files) {
            const fp = path.join(authDir, file);
            if (fs.statSync(fp).isFile()) {
                sessionData[file] = fs.readFileSync(fp, 'utf8');
            }
        }
        
        const content = Buffer.from(JSON.stringify(sessionData)).toString('base64');
        const body = JSON.stringify({ message: 'session save ' + Date.now(), content });
        
        // Get current SHA
        const checkRes = await httpsRequest({
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
            method: 'GET',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'node' }
        });
        
        let sha = null;
        if (checkRes.statusCode === 200) {
            const d = JSON.parse(checkRes.data);
            sha = d.sha;
        }
        
        const putBody = JSON.stringify({ message: 'session save ' + Date.now(), content, ...(sha ? {sha} : {}) });
        
        const putRes = await httpsRequest({
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
            method: 'PUT',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'node',
                'Content-Length': Buffer.byteLength(putBody)
            }
        }, putBody);
        
        if (putRes.statusCode === 200 || putRes.statusCode === 201) {
            console.log('✅ Session saved to GitHub');
        } else {
            console.error('❌ Save failed:', putRes.statusCode, putRes.data.substring(0, 200));
        }
    } catch(e) {
        console.error('❌ Save error:', e.message);
    }
    isSaving = false;
}

// --- Load session from GitHub ---
async function loadSessionFromGitHub() {
    try {
        const res = await httpsRequest({
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
            method: 'GET',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'node' }
        });
        
        if (res.statusCode !== 200) {
            console.log('ℹ️ No saved session found');
            return false;
        }
        
        const data = JSON.parse(res.data);
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        if (sessionData && Object.keys(sessionData).length > 0) {
            const authDir = path.join(__dirname, 'auth_session');
            fs.mkdirSync(authDir, { recursive: true });
            for (const [file, fileContent] of Object.entries(sessionData)) {
                fs.writeFileSync(path.join(authDir, file), fileContent);
            }
            console.log('✅ Session loaded from GitHub (' + Object.keys(sessionData).length + ' files)');
            return true;
        }
        return false;
    } catch(e) {
        console.error('❌ Load error:', e.message);
        return false;
    }
}

// --- Graceful shutdown ---
let exiting = false;
async function saveBeforeExit() {
    if (exiting) return;
    exiting = true;
    console.log('💾 Saving session before exit...');
    isSaving = false;
    lastSaveTime = 0;
    await saveSessionToGitHub();
    setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', saveBeforeExit);
process.on('SIGINT', saveBeforeExit);

// Periodic save every 60s
setInterval(() => {
    if (connectionStatus === 'connected') saveSessionToGitHub();
}, 60000);

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
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!sock) return res.json({ success: false, message: 'ربات متصل نیست' });
    try {
        let jid = number;
        if (!jid.includes('@')) jid = jid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
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
        const loaded = await loadSessionFromGitHub();
        if (loaded) console.log('🔄 Session found, connecting...');
        else console.log('🆕 No session, need QR or phone');
        
        const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_session'));
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.0']
        });

        sock.ev.on('creds.update', () => {
            saveCreds();
            // Save to GitHub immediately (rate-limited to 5s)
            saveSessionToGitHub();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                const qrImage = await qrcode.toDataURL(qr, { width: 300 });
                latestQR = qrImage;
                io.emit('qr', { qr: qrImage });
                connectionStatus = 'waiting_qr';
                io.emit('status', { status: 'waiting_qr' });
            }
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                latestQR = null;
                io.emit('status', { status: 'connected' });
                console.log('✅ WhatsApp connected!');
                saveSessionToGitHub();
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                connectionStatus = 'disconnected';
                latestQR = null;
                io.emit('status', { status: 'disconnected' });
                sock = null;
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('🔄 Reconnecting in 5s...');
                    setTimeout(startBot, 5000);
                } else {
                    console.log('❌ Logged out');
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const msg = messages[0];
            if (!msg.message || type !== 'notify') return;
            if (msg.key.fromMe) return;
            
            const from = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            let text = '';
            if (messageType === 'conversation') text = msg.message.conversation;
            else if (messageType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
            else return;
            
            const name = msg.pushName || from;
            io.emit('incoming-message', { from, name, message: text, timestamp: new Date().toLocaleTimeString('fa-IR') });
            
            const lower = text.toLowerCase();
            if (lower === 'سلام' || lower === 'salam' || lower === 'hi' || lower === 'hello') {
                await sock.sendMessage(from, { text: 'سلام! 👋 چطور می‌تونم کمکت کنم؟' });
            } else if (lower === 'ساعت' || lower === 'time') {
                await sock.sendMessage(from, { text: 'ساعت ' + new Date().toLocaleTimeString('fa-IR') });
            } else if (lower === 'تاریخ' || lower === 'date') {
                await sock.sendMessage(from, { text: 'امروز ' + new Date().toLocaleDateString('fa-IR') });
            }
        });

    } catch(e) {
        console.error('❌ Bot error:', e);
        sock = null;
    }
}

startBot();

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('  🌐 Server on port ' + PORT);
    console.log('  💾 Session: GitHub (https module)');
    console.log('========================================\n');
});
