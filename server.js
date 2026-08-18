const express = require('express');
const http = require('http');
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
let saveTimer = null;
let isSaving = false;

// GitHub Config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_5 || '';
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

// --- ذخیره session روی GitHub (با debounce) ---
async function saveSessionToGitHub() {
    if (!GITHUB_TOKEN || isSaving) return;
    isSaving = true;
    try {
        const authDir = path.join(__dirname, 'auth_session');
        if (!fs.existsSync(authDir)) { isSaving = false; return; }
        
        const files = fs.readdirSync(authDir);
        if (files.length === 0) { isSaving = false; return; }
        
        const sessionData = {};
        for (const file of files) {
            const filePath = path.join(authDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                sessionData[file] = fs.readFileSync(filePath, 'utf8');
            }
        }
        
        const content = Buffer.from(JSON.stringify(sessionData)).toString('base64');
        
        // SHA فعلی رو بگیر
        let sha = null;
        try {
            const checkRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
                headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
            });
            if (checkRes.ok) {
                sha = (await checkRes.json()).sha;
            }
        } catch(e) {}
        
        const body = { message: 'auto-save session ' + new Date().toISOString(), content };
        if (sha) body.sha = sha;
        
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        
        if (res.ok) console.log('✅ Session saved to GitHub');
    } catch(e) {
        console.error('Save error:', e.message);
    }
    isSaving = false;
}

// ذخیره با debounce - هر تغییر فوری ولی نه بیشتر از یکی هر ۱۰ ثانیه
function debouncedSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveSessionToGitHub();
    }, 10000);
}

// --- بارگذاری session از GitHub ---
async function loadSessionFromGitHub() {
    if (!GITHUB_TOKEN) {
        console.log('⚠️ GITHUB_TOKEN تنظیم نشده - session از GitHub بارگذاری نمی‌شود');
        return false;
    }
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) {
            console.log('ℹ️ Session قبلی روی GitHub پیدا نشد');
            return false;
        }
        
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        if (sessionData && Object.keys(sessionData).length > 0) {
            const authDir = path.join(__dirname, 'auth_session');
            fs.mkdirSync(authDir, { recursive: true });
            for (const [file, fileContent] of Object.entries(sessionData)) {
                fs.writeFileSync(path.join(authDir, file), fileContent);
            }
            console.log('✅ Session از GitHub بارگذاری شد');
            return true;
        }
        return false;
    } catch(e) {
        console.error('Load error:', e.message);
        return false;
    }
}

// ذخیره قبل از خروج (graceful shutdown)
async function saveBeforeExit() {
    console.log('💾 Saving session before exit...');
    await saveSessionToGitHub();
    process.exit(0);
}
process.on('SIGTERM', saveBeforeExit);
process.on('SIGINT', saveBeforeExit);

// --- Routes ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, qr: latestQR });
});

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

// --- ربات ---
async function startBot() {
    if (sock) return;
    
    try {
        // اول session رو از GitHub بارگذاری کن
        const loaded = await loadSessionFromGitHub();
        if (loaded) console.log('🔄 Session قبلی پیدا شد، در حال اتصال...');
        else console.log('🆕 Session قبلی نیست، نیاز به QR یا شماره');
        
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
            debouncedSave(); // هر تغییر session رو فوراً روی GitHub ذخیره کن
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
                console.log('✅ واتساپ متصل شد!');
                saveSessionToGitHub(); // فوراً بعد از اتصال ذخیره کن
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                connectionStatus = 'disconnected';
                latestQR = null;
                io.emit('status', { status: 'disconnected' });
                sock = null;
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('🔄 reconnecting in 5s...');
                    setTimeout(startBot, 5000);
                } else {
                    console.log('❌ Logged out - need new QR');
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
            io.emit('incoming-message', {
                from, name, message: text,
                timestamp: new Date().toLocaleTimeString('fa-IR')
            });
            
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
    console.log(`\n========================================`);
    console.log(`  🌐 سرور روی پورت ${PORT}`);
    console.log(`  📱 پنل: http://localhost:${PORT}`);
    console.log(`  💾 Session backup: GitHub`);
    console.log(`========================================\n`);
});
