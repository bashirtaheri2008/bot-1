const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

// 🔐 PIN
const PIN_FILE = 'pin.json';
const DEFAULT_PIN = '1234';

function getPIN() {
    try {
        if (fs.existsSync(PIN_FILE)) {
            return JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).pin || DEFAULT_PIN;
        }
    } catch (error) {}
    return DEFAULT_PIN;
}

function savePIN(newPin) {
    try {
        fs.writeFileSync(PIN_FILE, JSON.stringify({ pin: newPin }));
        return true;
    } catch (error) {
        return false;
    }
}

// 🤖 پاسخ خودکار
const AUTO_REPLY_FILE = 'auto-replies.json';

function getAutoReplies() {
    try {
        if (fs.existsSync(AUTO_REPLY_FILE)) {
            return JSON.parse(fs.readFileSync(AUTO_REPLY_FILE, 'utf8'));
        }
    } catch (error) {}
    return [];
}

function saveAutoReplies(replies) {
    try {
        fs.writeFileSync(AUTO_REPLY_FILE, JSON.stringify(replies, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

// 📦 GitHub Config
const GITHUB_TOKEN = 'YOUR_GITHUB_TOKEN';
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

async function saveSessionToGitHub() {
    try {
        const files = fs.readdirSync('auth_session');
        const sessionData = {};
        for (const file of files) {
            sessionData[file] = fs.readFileSync(`auth_session/${file}`, 'utf8');
        }
        const content = Buffer.from(JSON.stringify(sessionData)).toString('base64');
        
        const checkResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        let sha = null;
        if (checkResponse.ok) {
            sha = (await checkResponse.json()).sha;
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
    try {
        const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!response.ok) return false;
        
        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        if (sessionData && Object.keys(sessionData).length > 0) {
            fs.mkdirSync('auth_session', { recursive: true });
            for (const [file, content] of Object.entries(sessionData)) {
                fs.writeFileSync(`auth_session/${file}`, content);
            }
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

setInterval(saveSessionToGitHub, 300000);

// 📱 Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔐 PIN Routes
app.post('/verify-pin', (req, res) => {
    const { pin } = req.body;
    if (pin === getPIN()) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'PIN اشتباه است' });
    }
});

app.post('/change-pin', (req, res) => {
    const { oldPin, newPin } = req.body;
    
    if (oldPin !== getPIN()) {
        return res.json({ success: false, message: 'PIN فعلی اشتباه است' });
    }
    if (!newPin || newPin.length < 4) {
        return res.json({ success: false, message: 'PIN جدید باید حداقل ۴ رقم باشد' });
    }
    
    if (savePIN(newPin)) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'خطا در ذخیره' });
    }
});

// 🤖 Auto Reply Routes
app.post('/add-auto-reply', (req, res) => {
    const { keyword, response } = req.body;
    
    if (!keyword || !response) {
        return res.json({ success: false, message: 'کلمه کلیدی و پاسخ را وارد کنید' });
    }
    
    const replies = getAutoReplies();
    replies.push({ keyword: keyword.toLowerCase(), response });
    saveAutoReplies(replies);
    
    res.json({ success: true });
});

app.get('/get-auto-replies', (req, res) => {
    res.json({ replies: getAutoReplies() });
});

app.post('/delete-auto-reply', (req, res) => {
    const { keyword } = req.body;
    const replies = getAutoReplies().filter(r => r.keyword !== keyword.toLowerCase());
    saveAutoReplies(replies);
    res.json({ success: true });
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
            const code = await sock.requestPairingCode(phone);
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
        const jid = number.includes('@c.us') ? number : `${number}@c.us`;
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
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                const qrImage = await qrcode.toDataURL(qr);
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
            
            const from = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];
            
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                const text = messageType === 'conversation' 
                    ? msg.message.conversation 
                    : msg.message.extendedTextMessage.text;
                
                io.emit('incoming-message', {
                    from,
                    message: text,
                    timestamp: new Date().toLocaleTimeString('fa-IR')
                });
                
                // 🤖 بررسی پاسخ خودکار
                const replies = getAutoReplies();
                const match = replies.find(r => text.toLowerCase().includes(r.keyword));
                
                if (match) {
                    await sock.sendMessage(from, { text: match.response });
                    io.emit('auto-reply-sent', { keyword: match.keyword });
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
server.listen(PORT, () => {
    console.log(`🌐 سرور روی پورت ${PORT}`);
});
