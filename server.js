const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
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

// 📦 Supabase Config
const SUPABASE_URL = 'https://xdnnnhuxqpscjynmejum.supabase.co';
const SUPABASE_KEY = 'sb_publishable_CdhDddnsDaac97dU4x5uhg_ODSWyeXu';

async function saveSession(key, value) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
                key: key,
                value: value,
                updated_at: new Date().toISOString()
            })
        });
    } catch (error) {
        console.error('خطا در ذخیره:', error);
    }
}

async function loadSession(key) {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/sessions?key=eq.${key}&select=value`, {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            }
        });
        const data = await response.json();
        return data[0]?.value || null;
    } catch (error) {
        console.error('خطا در خواندن:', error);
        return null;
    }
}

async function useSupabaseAuthState() {
    const creds = (await loadSession('creds')) || {};
    const keys = (await loadSession('keys')) || {};

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
                    }
                    await saveSession('keys', keys);
                }
            }
        },
        saveCreds: async () => {
            await saveSession('creds', creds);
        }
    };
}

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

async function startBot() {
    if (sock) return;
    
    try {
        console.log('🚀 شروع ربات...');
        const { state, saveCreds } = await useSupabaseAuthState();
        
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

startBot();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 سرور روی پورت ${PORT}`);
});
