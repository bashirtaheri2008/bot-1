const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
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

// 📦 MongoDB Connection
const MONGODB_URI = 'mongodb://admin:bashir2008@ac-4ft4dn9-shard-00-00.candod8.mongodb.net:27017,ac-4ft4dn9-shard-00-01.candod8.mongodb.net:27017,ac-4ft4dn9-shard-00-02.candod8.mongodb.net:27017/?ssl=true&replicaSet=atlas-3iisrr-shard-0&authSource=admin&appName=Cluster0';

// Session Model
const SessionSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', SessionSchema);

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ متصل به MongoDB'))
    .catch(err => console.error('❌ خطای MongoDB:', err));

// 🔄 استفاده از MongoDB برای auth state
async function useMongoAuthState() {
    const writeData = async (key, value) => {
        try {
            await Session.findOneAndUpdate(
                { key },
                { key, value, updatedAt: new Date() },
                { upsert: true }
            );
        } catch (error) {
            console.error('خطا در ذخیره:', error);
        }
    };

    const readData = async (key) => {
        try {
            const doc = await Session.findOne({ key });
            return doc ? doc.value : null;
        } catch (error) {
            console.error('خطا در خواندن:', error);
            return null;
        }
    };

    const creds = (await readData('creds')) || {};
    const keys = (await readData('keys')) || {};

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const key = `${type}_${ids.join('_')}`;
                    return keys[key] || null;
                },
                set: async (data) => {
                    for (const [key, value] of Object.entries(data)) {
                        keys[key] = value;
                        await writeData(`key_${key}`, value);
                    }
                    await writeData('keys', keys);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}

// 📱 Routes
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
    res.json({ success: true, message: 'در حال اتصال...' });
});

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

// 🤖 شروع ربات
async function startBot() {
    if (sock) return;
    
    try {
        console.log('🚀 شروع ربات...');
        const { state, saveCreds } = await useMongoAuthState();
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.0'],
            markOnlineOnConnect: true
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log('📊 وضعیت:', connection, qr ? '| QR موجوده' : '');
            
            if (qr) {
                console.log('📱 QR تولید شد');
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
                console.log('✅ ربات وصل شد!');
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('🔍 قطع شد، کد:', statusCode);
                
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
                
                console.log(`📩 پیام از ${from}: ${text}`);
                
                if (text.toLowerCase() === 'سلام') {
                    await sock.sendMessage(from, { text: 'سلام! 👋 چطور می‌تونم کمکت کنم؟' });
                }
            }
        });

    } catch (error) {
        console.error('❌ خطا:', error);
        sock = null;
    }
}

// 🚀 اجرای خودکار
startBot();

// 🌐 سرور
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 سرور روی پورت ${PORT}`);
});
