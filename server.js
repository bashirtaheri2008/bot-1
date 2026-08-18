const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
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

// 📦 MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-bot';

const SessionSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', SessionSchema);

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ متصل به MongoDB'))
    .catch(err => console.error('❌ خطای MongoDB:', err));

// 🔄 Custom Auth State با MongoDB
class MongoAuthState {
    constructor() {
        this.creds = null;
        this.keys = {};
    }

    async load() {
        try {
            const credDoc = await Session.findOne({ key: 'creds' });
            if (credDoc) this.creds = credDoc.value;
            
            const keyDocs = await Session.find({ key: { $regex: '^key_' } });
            keyDocs.forEach(doc => {
                const keyName = doc.key.replace('key_', '');
                this.keys[keyName] = doc.value;
            });
        } catch (error) {
            console.error('خطا در load:', error);
        }
        return this;
    }

    get state() {
        return { creds: this.creds || {}, keys: this.keys };
    }

    async saveCreds() {
        try {
            await Session.findOneAndUpdate(
                { key: 'creds' },
                { key: 'creds', value: this.creds, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (error) {
            console.error('خطا در saveCreds:', error);
        }
    }

    async saveKeys() {
        try {
            for (const [key, value] of Object.entries(this.keys)) {
                await Session.findOneAndUpdate(
                    { key: `key_${key}` },
                    { key: `key_${key}`, value, updatedAt: new Date() },
                    { upsert: true }
                );
            }
        } catch (error) {
            console.error('خطا در saveKeys:', error);
        }
    }
}

// 📱 صفحه اصلی
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔌 شروع اتصال
app.post('/connect', async (req, res) => {
    if (sock) {
        return res.json({ success: false, message: 'ربات در حال اجراست' });
    }
    await startBot();
    res.json({ success: true, message: 'در حال اتصال...' });
});

// 📤 ارسال پیام
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    
    if (!sock) {
        return res.json({ success: false, message: 'ربات متصل نیست' });
    }
    
    try {
        const jid = number.includes('@c.us') ? number : `${number}@c.us`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'پیام ارسال شد' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// 🔌 قطع اتصال
app.post('/disconnect', async (req, res) => {
    if (sock) {
        await sock.logout();
        sock = null;
        connectionStatus = 'disconnected';
        io.emit('status', { status: 'disconnected' });
    }
    res.json({ success: true });
});

// 📊 وضعیت
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus });
});

async function startBot() {
    try {
        const authState = new MongoAuthState();
        await authState.load();
        
        sock = makeWASocket({
            auth: authState.state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                const qrImage = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: qrImage });
                connectionStatus = 'waiting_qr';
                io.emit('status', { status: 'waiting_qr' });
            }
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                io.emit('status', { status: 'connected' });
                console.log('✅ ربات وصل شد!');
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                io.emit('status', { status: 'disconnected' });
                
                if (shouldReconnect) {
                    setTimeout(() => {
                        sock = null;
                        startBot();
                    }, 3000);
                } else {
                    sock = null;
                }
            }
        });

        sock.ev.on('creds.update', async (creds) => {
            authState.creds = creds;
            await authState.saveCreds();
        });

        const saveInterval = setInterval(async () => {
            await authState.saveKeys();
        }, 10000);

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
                
                console.log(`📩 پیام از ${from}: ${text}`);
                
                if (text.toLowerCase() === 'سلام') {
                    await sock.sendMessage(from, { text: 'سلام! 👋 چطور می‌تونم کمکت کنم؟' });
                }
            }
        });

    } catch (error) {
        console.error('❌ خطا:', error);
        io.emit('error', { message: error.message });
    }
}

// 🚀 اجرای خودکار
startBot();

// 🔄 Keep Alive (هر ۵ دقیقه)
setInterval(() => {
    const url = `http://localhost:${process.env.PORT || 3000}`;
    http.get(url + '/status', () => {}).on('error', () => {});
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 داشبورد در: http://localhost:${PORT}`);
});