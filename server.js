const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
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
let botEnabled = true;

// 🔐 PIN
const PIN_FILE = 'pin.json';
const DEFAULT_PIN = '1234';

function getPIN() {
    try {
        if (fs.existsSync(PIN_FILE)) {
            return JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).pin || DEFAULT_PIN;
        }
    } catch (e) {}
    return DEFAULT_PIN;
}

function savePIN(newPin) {
    try {
        fs.writeFileSync(PIN_FILE, JSON.stringify({ pin: newPin }));
        return true;
    } catch (e) { return false; }
}

// 🤖 Auto Reply
const AUTO_REPLY_FILE = 'auto-replies.json';
function getAutoReplies() {
    try { if (fs.existsSync(AUTO_REPLY_FILE)) return JSON.parse(fs.readFileSync(AUTO_REPLY_FILE, 'utf8')); } catch (e) {}
    return [];
}
function saveAutoReplies(replies) {
    try { fs.writeFileSync(AUTO_REPLY_FILE, JSON.stringify(replies, null, 2)); return true; } catch (e) { return false; }
}

// 🛍️ Products
const PRODUCTS_FILE = 'products.json';
function getProducts() {
    try { if (fs.existsSync(PRODUCTS_FILE)) return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); } catch (e) {}
    return [];
}
function saveProducts(products) {
    try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2)); return true; } catch (e) { return false; }
}

// 💱 Check Receipt
const CHECK_CONFIG_FILE = 'check-config.json';
let checkConfig = { active: false, groupJid: '', targetJid: '' };
let forwardedMap = {};

function loadCheckConfig() {
    try {
        if (fs.existsSync(CHECK_CONFIG_FILE)) {
            checkConfig = JSON.parse(fs.readFileSync(CHECK_CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
}
function saveCheckConfig() {
    try { fs.writeFileSync(CHECK_CONFIG_FILE, JSON.stringify(checkConfig, null, 2)); } catch (e) {}
}

// 📦 GitHub Session Storage
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'YOUR_GITHUB_TOKEN';
const GITHUB_REPO = 'bashirtaheri2008/bot-1';
const GITHUB_FILE = 'session-data.json';

async function saveSessionToGitHub() {
    try {
        if (!fs.existsSync('auth_session')) return;
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
        if (checkResponse.ok) sha = (await checkResponse.json()).sha;

        const body = { message: 'save session', content };
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
    } catch (e) { console.error('خطا در ذخیره session:', e.message); }
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
    } catch (e) { return false; }
}

setInterval(saveSessionToGitHub, 300000);

// 🔐 PIN Routes
app.post('/verify-pin', (req, res) => {
    if (req.body.pin === getPIN()) res.json({ success: true });
    else res.json({ success: false, message: 'PIN اشتباه است' });
});

app.post('/change-pin', (req, res) => {
    const { oldPin, newPin } = req.body;
    if (oldPin !== getPIN()) return res.json({ success: false, message: 'PIN فعلی اشتباه است' });
    if (!newPin || newPin.length < 4) return res.json({ success: false, message: 'PIN جدید باید حداقل ۴ رقم باشد' });
    if (savePIN(newPin)) res.json({ success: true });
    else res.json({ success: false, message: 'خطا' });
});

// 🔌 Bot Toggle
app.get('/get-bot-status', (req, res) => res.json({ enabled: botEnabled }));

app.post('/toggle-bot', (req, res) => {
    botEnabled = !!req.body.enabled;
    res.json({ success: true, enabled: botEnabled });
});

// 🤖 Auto Reply Routes
app.post('/add-auto-reply', (req, res) => {
    const { keyword, response } = req.body;
    if (!keyword || !response) return res.json({ success: false });
    const replies = getAutoReplies();
    replies.push({ keyword: keyword.toLowerCase(), response });
    saveAutoReplies(replies);
    res.json({ success: true });
});

app.get('/get-auto-replies', (req, res) => res.json({ replies: getAutoReplies() }));

app.post('/delete-auto-reply', (req, res) => {
    const replies = getAutoReplies().filter(r => r.keyword !== req.body.keyword.toLowerCase());
    saveAutoReplies(replies);
    res.json({ success: true });
});

// 🛍️ Shop Routes
app.post('/add-product', (req, res) => {
    const { name, price, desc } = req.body;
    if (!name || !price) return res.json({ success: false });
    const products = getProducts();
    products.push({ name, price, desc: desc || '' });
    saveProducts(products);
    res.json({ success: true });
});

app.get('/get-products', (req, res) => res.json({ products: getProducts() }));

app.post('/delete-product', (req, res) => {
    const products = getProducts().filter(p => p.name !== req.body.name);
    saveProducts(products);
    res.json({ success: true });
});

// 💱 Check Receipt Routes
app.get('/get-groups', async (req, res) => {
    if (!sock) return res.json({ groups: [] });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.entries(groups).map(([jid, info]) => ({ jid, name: info.subject }));
        res.json({ groups: list });
    } catch (e) { res.json({ groups: [] }); }
});

app.get('/get-check-config', (req, res) => res.json(checkConfig));

app.post('/save-check-config', (req, res) => {
    const { active, groupJid, targetJid } = req.body;
    checkConfig = { active: !!active, groupJid: groupJid || '', targetJid: targetJid || '' };
    saveCheckConfig();
    res.json({ success: true });
});

app.post('/toggle-check', (req, res) => {
    checkConfig.active = !!req.body.active;
    saveCheckConfig();
    res.json({ success: true, active: checkConfig.active });
});

// 📊 Status & Connect
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: latestQR }));

app.post('/connect', async (req, res) => {
    if (sock) return res.json({ success: false, message: 'ربات در حال اجراست' });
    await startBot();
    res.json({ success: true });
});

app.post('/connect-phone', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ success: false });
    try {
        if (!sock) { await startBot(); await new Promise(r => setTimeout(r, 3000)); }
        if (sock) {
            const code = await sock.requestPairingCode(phone);
            io.emit('pairing-code', { code });
            res.json({ success: true, code });
        } else res.json({ success: false });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!sock) return res.json({ success: false });
    try {
        const jid = number.includes('@c.us') ? number : `${number}@c.us`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: e.message }); }
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

// 🚀 Bot Start
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
                if (botEnabled) {
                    const qrImage = await qrcode.toDataURL(qr);
                    latestQR = qrImage;
                    io.emit('qr', { qr: qrImage });
                    connectionStatus = 'waiting_qr';
                    io.emit('status', { status: 'waiting_qr' });
                }
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
                    setTimeout(() => { sock = null; startBot(); }, 5000);
                } else sock = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const msg = messages[0];
            if (!msg.message || type !== 'notify') return;
            if (!botEnabled) return;

            const from = msg.key.remoteJid;
            const messageType = Object.keys(msg.message)[0];

            // Text messages
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                const text = messageType === 'conversation' ? msg.message.conversation : msg.message.extendedTextMessage.text;
                io.emit('incoming-message', { from, message: text, timestamp: new Date().toLocaleTimeString('fa-IR') });

                const replies = getAutoReplies();
                const match = replies.find(r => text.toLowerCase().includes(r.keyword));
                if (match) await sock.sendMessage(from, { text: match.response });

                if (text.toLowerCase().includes('محصول') || text.toLowerCase().includes('کالا')) {
                    const products = getProducts();
                    if (products.length) {
                        let txt = '🛍️ محصولات:\n';
                        products.forEach(p => txt += `📦 ${p.name}: ${p.price}${p.desc ? ' - ' + p.desc : ''}\n`);
                        await sock.sendMessage(from, { text: txt });
                    }
                }
            }

            // Receipt image forwarding
            if (messageType === 'imageMessage' && checkConfig.active && from === checkConfig.groupJid) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const sent = await sock.sendMessage(checkConfig.targetJid, {
                        image: buffer,
                        caption: `📄 فیش جدید از گروه\nاز: ${from}\nلطفاً بررسی کنید و در صورت تأیید 👍 بزنید.`
                    });
                    forwardedMap[sent.key.id] = msg.key;
                } catch (e) { console.error('خطا در ارسال فیش:', e.message); }
            }

            // Reaction forwarding
            if (messageType === 'reaction') {
                const reaction = msg.message.reaction;
                const reactedKey = reaction.key;
                if (forwardedMap[reactedKey.id] && (reaction.text === '👍' || reaction.text === '✅')) {
                    const originalKey = forwardedMap[reactedKey.id];
                    try {
                        await sock.sendMessage(originalKey.remoteJid, {
                            react: { text: reaction.text, key: originalKey }
                        });
                        delete forwardedMap[reactedKey.id];
                    } catch (e) { console.error('خطا در اعمال ریکشن:', e.message); }
                }
            }
        });

    } catch (error) {
        console.error('❌ خطا:', error);
        sock = null;
    }
}

// Init
loadCheckConfig();
startBot();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 سرور روی پورت ${PORT}`);
});
