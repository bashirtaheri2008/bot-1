const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
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

// 📱 صفحه اصلی
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 📊 وضعیت
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, qr: latestQR });
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
        latestQR = null;
        io.emit('status', { status: 'disconnected' });
    }
    res.json({ success: true });
});

// 🤖 شروع ربات
async function startBot() {
    if (sock) {
        console.log('⚠️ ربات در حال اجراست');
        return;
    }
    
    try {
        console.log('🚀 شروع ربات...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log('📊 وضعیت:', connection, qr ? '| QR موجوده' : '');
            
            if (qr) {
                console.log('📱 تولید QR...');
                try {
                    const qrImage = await qrcode.toDataURL(qr);
                    latestQR = qrImage;
                    io.emit('qr', { qr: qrImage });
                    connectionStatus = 'waiting_qr';
                    io.emit('status', { status: 'waiting_qr' });
                } catch (qrError) {
                    console.error('خطا در تولید QR:', qrError);
                }
            }
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                latestQR = null;
                io.emit('status', { status: 'connected' });
                console.log('✅ ربات وصل شد!');
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('🔍 دلیل قطع:', statusCode);
                
                connectionStatus = 'disconnected';
                latestQR = null;
                io.emit('status', { status: 'disconnected' });
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('🔄 تلاش مجدد در ۵ ثانیه...');
                    setTimeout(() => {
                        sock = null;
                        startBot();
                    }, 5000);
                } else {
                    console.log('❌ خروج کامل');
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
        console.error('❌ خطا در startBot:', error);
        sock = null;
        io.emit('error', { message: error.message });
    }
}

// 🚀 اجرای خودکار
console.log('🎯 در حال اجرای startBot...');
startBot();

// 🌐 شروع سرور
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 سرور روی پورت ${PORT}`);
});
