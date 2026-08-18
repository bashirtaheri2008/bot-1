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

// 📦 GitHub Config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

// توابع GitHub
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
        
        const checkResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        let sha = null;
        if (checkResponse.ok) {
            const data = await checkResponse.json();
            sha = data.sha;
        }
        
        const body = { message: 'save session', content: content };
        if (sha) body.sha = sha;
        
        await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.error('خطا در ذخیره:', error.message);
    }
}

async function loadSessionFromGitHub() {
    if (!GITHUB_TOKEN) return false;
    try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!response.ok) return false;
        
        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        if (sessionData && Object.keys(sessionData).length > 0) {
            fs.mkdirSync(path.join(__dirname, 'auth_session'), { recursive: true });
            for (const [file, content] of Object.entries(sessionData)) {
                fs.writeFileSync(path.join(__dirname, 'auth_session', file), content);
            }
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

setInterval(saveSessionToGitHub, 300000);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, qr: latestQR });
});

app.post('/connect', async (req, res) => {
    if (sock) {
        return res.json({ success: false, message: 'ربات در حال اجراست' });
    }
    await startBot();
    res.json({ success: true });
});

// 📱 اتصال با شماره موبایل
app.post('/connect-phone', async (req, res) => {
    const { phone } = req.body;
    
    if (!phone) {
        return res.json({ success: false, message: 'شماره را وارد کنید' });
    }
    
    try {
        if (!sock) {
            await startBot();
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        if (sock) {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(cleanPhone);
            io.emit('pairing-code', { code });
            res.json({ success: true, code });
        } else {
            res.json({ success: false, message: 'ربات آماده نیست' });
        }
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    
    if (!sock) {
        return res.json({ success: false, message: 'ربات متصل نیست' });
    }
    
    try {
        let jid = number;
        if (!jid.includes('@')) {
            jid = jid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/disconnect', async (req, res) => {
    if (sock) {
        await sock.logout();
        sock = null;
        connectionStatus = 'disconnected';
        latestQR = null;
        io.emit('status', { status: 'disconnected' });
    }
    res.json({ success: true });
});

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
            browser: ['Ubuntu', 'Chrome', '20.0.0']
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
                setTimeout(saveSessionToGitHub, 5000);
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                connectionStatus = 'disconnected';
                latestQR = null;
                io.emit('status', { status: 'disconnected' });
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(() => {
                        sock = null;
                        startBot();
                    }, 5000);
                } else {
                    sock = null;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const msg = messages[0];
            if (!msg.message || type !== 'notify') return;
            if (msg.key.fromMe) return;
            
            const from = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                const text = messageType === 'conversation' 
                    ? msg.message.conversation 
                    : msg.message.extendedTextMessage.text;
                
                const name = msg.pushName || from;
                
                io.emit('incoming-message', {
                    from,
                    name,
                    message: text,
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
            }
        });

    } catch (error) {
        console.error('❌ خطا:', error);
        sock = null;
    }
}

startBot();

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  🌐 سرور روی پورت ${PORT}`);
    console.log(`  📱 پنل: http://localhost:${PORT}`);
    console.log(`========================================\n`);
});
