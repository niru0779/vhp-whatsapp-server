/**
 * VHP Membership — Free Baileys WhatsApp Gateway Server
 * ─────────────────────────────────────────────────────
 * 100% Free WhatsApp Web automation server.
 * Connects via QR Code scanning on your phone.
 * Supports:
 *  - 2-way live chatbot auto-reply (ID Card downloads)
 *  - Automated WhatsApp OTP sending for members
 *  - Immediate registration & approval alerts
 */

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3333;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// Config file for persistent webhook url
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
    webhookUrl: 'http://localhost/wp-json/vhpm/v1/whatsapp-webhook',
    apiKey: 'vhp_wa_secret_2026'
};
if (fs.existsSync(CONFIG_FILE)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (e) {}
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let qrRaw = null;
let qrDataUrl = null;
let connectionStatus = 'initializing'; // initializing, waiting_qr, connected, disconnected
let connectedPhone = null;
let connectedName = null;

// ── Persistent WordPress Cloud Session Sync ─────────────────────────────────
function getSessionEndpoint() {
    return (config.webhookUrl || '').replace('/whatsapp-webhook', '/whatsapp-session');
}

async function restoreSessionFromWP() {
    try {
        const ep = getSessionEndpoint();
        if (!ep || !ep.startsWith('http')) return false;
        const res = await fetch(ep, {
            headers: { 'X-VHP-Secret': config.apiKey || '' }
        });
        const data = await res.json();
        if (data && data.success && data.hasSession && data.files) {
            if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
            for (const [fname, content] of Object.entries(data.files)) {
                fs.writeFileSync(path.join(AUTH_DIR, fname), content, 'utf8');
            }
            console.log(`📦 WordPress से ${Object.keys(data.files).length} WhatsApp सेशन फाइलें रिस्टोर की गईं!`);
            return true;
        }
    } catch (e) {
        console.log('Session restore notice:', e.message);
    }
    return false;
}

let syncTimeout = null;
function scheduleSessionSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(syncSessionToWP, 2500);
}

async function syncSessionToWP() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const fileNames = fs.readdirSync(AUTH_DIR);
        if (fileNames.length === 0) return;
        const files = {};
        for (const fname of fileNames) {
            const p = path.join(AUTH_DIR, fname);
            if (fs.statSync(p).isFile()) {
                files[fname] = fs.readFileSync(p, 'utf8');
            }
        }
        const ep = getSessionEndpoint();
        if (!ep || !ep.startsWith('http')) return;
        await fetch(ep, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-VHP-Secret': config.apiKey || ''
            },
            body: JSON.stringify({ files })
        });
        console.log(`☁️ WordPress में ${Object.keys(files).length} सेशन फाइलें हमेशा के लिए सुरक्षित की गईं!`);
    } catch (e) {
        console.error('Session sync error:', e.message);
    }
}

async function deleteSessionFromWP() {
    try {
        const ep = getSessionEndpoint();
        if (!ep || !ep.startsWith('http')) return;
        await fetch(ep, {
            method: 'DELETE',
            headers: { 'X-VHP-Secret': config.apiKey || '' }
        });
    } catch (e) {}
}

// ── Start Baileys WhatsApp Socket ─────────────────────────────────────────────
async function startWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        // Try restoring session from WordPress cloud storage first
        await restoreSessionFromWP();

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['VHP Membership Manager', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            scheduleSessionSync();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrRaw = qr;
                connectionStatus = 'waiting_qr';
                try {
                    qrDataUrl = await QRCode.toDataURL(qr);
                    console.log('📱 नया WhatsApp QR Code तैयार है! ब्राउज़र में खोलें: http://localhost:' + PORT);
                } catch (err) {
                    console.error('QR Generate Error:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = 'disconnected';
                qrRaw = null;
                qrDataUrl = null;
                connectedPhone = null;
                console.log('⚠️ WhatsApp कनेक्शन बंद हुआ। StatusCode:', statusCode, 'पुनः प्रयास:', shouldReconnect);

                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 3000);
                } else {
                    console.log('🔴 लॉगआउट हुआ। नया QR कोड स्कैन करने हेतु रीस्टार्ट करें।');
                    try { await deleteSessionFromWP(); } catch (e) {}
                    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                    setTimeout(startWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrRaw = null;
                qrDataUrl = null;
                const user = sock.user;
                connectedPhone = user?.id ? user.id.split(':')[0] : 'Unknown';
                connectedName = user?.name || 'VHP Admin';
                console.log(`✅ WhatsApp सफलतापूर्वक कनेक्ट हो गया! नंबर: +${connectedPhone} (${connectedName})`);
                scheduleSessionSync();
            }
        });

        // ── Incoming Messages Handler (Webhook Forwarding) ────────────────────
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                // Ignore self messages, broadcasts, and group chats
                if (msg.key.fromMe) continue;
                const remoteJid = msg.key.remoteJid || '';
                if (remoteJid.includes('@broadcast') || remoteJid.includes('@g.us')) continue;

                const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
                const text = msg.message?.conversation 
                          || msg.message?.extendedTextMessage?.text 
                          || msg.message?.imageMessage?.caption 
                          || '';

                if (!text || !text.trim()) continue;

                console.log(`📩 नया मैसेज आया (+${senderPhone}): "${text.trim()}"`);

                // Forward to WordPress Webhook
                if (config.webhookUrl) {
                    try {
                        const payload = {
                            from: senderPhone,
                            phone: senderPhone,
                            body: text.trim(),
                            message: text.trim(),
                            timestamp: Date.now()
                        };

                        const response = await fetch(config.webhookUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-VHP-Secret': config.apiKey || ''
                            },
                            body: JSON.stringify(payload)
                        });

                        const rawText = await response.text();
                        let resJson = null;
                        try {
                            const cleanText = rawText.trim().replace(/^\ufeff/, '');
                            resJson = JSON.parse(cleanText);
                        } catch (e1) {
                            const jsonMatch = rawText.match(/\{[\s\S]*?\}(?=\s*\{|$)/);
                            if (jsonMatch) {
                                try { resJson = JSON.parse(jsonMatch[0].replace(/^\ufeff/, '')); } catch (e2) {}
                            }
                        }

                        console.log('🤖 वर्डप्रेस बॉट उत्तर:', resJson?.reply ? 'रिप्लाई मिला' : 'कोई रिप्लाई नहीं');

                        if (resJson && resJson.reply) {
                            await sock.sendMessage(remoteJid, { text: resJson.reply });
                            console.log(`📤 सदस्य (+${senderPhone}) को उत्तर भेज दिया गया!`);
                        }
                    } catch (err) {
                        console.error('❌ WordPress Webhook फ़ॉरवर्डिंग विफल:', err.message);
                    }
                }
            }
        });

    } catch (err) {
        console.error('Baileys Init Error:', err);
        setTimeout(startWhatsApp, 5000);
    }
}

// ── REST API Endpoints ────────────────────────────────────────────────────────

// 1. Connection status
app.get('/status', (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        phone: connectedPhone,
        name: connectedName,
        webhookUrl: config.webhookUrl
    });
});

// 2. QR Code
app.get('/qr', (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        qr: qrDataUrl,
        phone: connectedPhone
    });
});

// 3. Send Message API (Used by WordPress for OTP, Alerts & ID Cards)
app.post('/send-message', async (req, res) => {
    try {
        const to = req.body.to || req.body.phone;
        const message = req.body.message || req.body.text || req.body.body;

        if (!to || !message) {
            return res.status(400).json({ success: false, error: 'to (phone) and message are required' });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp कनेक्ट नहीं है! कृपया पहले http://localhost:' + PORT + ' पर जाकर QR कोड स्कैन करें।'
            });
        }

        // Clean phone digits
        let cleanDigits = to.toString().replace(/\D/g, '');
        if (cleanDigits.length === 10) cleanDigits = '91' + cleanDigits;
        const jid = `${cleanDigits}@s.whatsapp.net`;

        const result = await sock.sendMessage(jid, { text: message.toString() });

        res.json({
            success: true,
            to: cleanDigits,
            messageId: result.key.id
        });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Update Webhook URL
app.post('/set-webhook', (req, res) => {
    const { webhookUrl, apiKey } = req.body;
    if (webhookUrl) config.webhookUrl = webhookUrl.trim();
    if (apiKey) config.apiKey = apiKey.trim();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ success: true, message: 'Webhook URL सुरक्षित कर दिया गया!', config });
});

// 5. Logout & Disconnect
app.get('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        try { await deleteSessionFromWP(); } catch (e) {}
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        connectionStatus = 'disconnected';
        connectedPhone = null;
        res.json({ success: true, message: 'सफलतापूर्वक लॉगआउट हुआ। नया QR कोड आ रहा है...' });
        setTimeout(startWhatsApp, 1500);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── HTML Dashboard ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>विश्व हिंदी परिषद — WhatsApp Web Gateway</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Mukta:wght@400;600;700;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Mukta', 'Inter', sans-serif; background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 16px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 20px; max-width: 580px; width: 100%; padding: 32px 28px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); text-align: center; }
        .logo-wrap { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 20px; }
        .logo-icon { font-size: 32px; background: #22c55e; width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 25px rgba(34,197,94,0.4); }
        h1 { font-size: 24px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px; }
        p.sub { font-size: 14px; color: #94a3b8; margin-top: 4px; }
        .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 50px; font-size: 13px; font-weight: 700; margin: 18px 0; }
        .badge.connected { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid #22c55e; }
        .badge.waiting_qr { background: rgba(234,179,8,0.15); color: #facc15; border: 1px solid #eab308; }
        .badge.disconnected { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid #ef4444; }
        .qr-box { background: #ffffff; border-radius: 16px; padding: 18px; display: inline-block; margin: 12px 0 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        .qr-box img { display: block; width: 230px; height: 230px; }
        .steps { text-align: left; background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 16px 20px; font-size: 13px; color: #cbd5e1; line-height: 1.8; margin-top: 15px; }
        .steps ol { padding-left: 20px; }
        .input-group { margin-top: 16px; text-align: left; }
        label { display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; }
        input, textarea { width: 100%; padding: 10px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 13px; outline: none; transition: border-color .2s; }
        input:focus, textarea:focus { border-color: #22c55e; }
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: #22c55e; color: #000; font-weight: 700; font-size: 14px; padding: 11px 22px; border-radius: 10px; border: none; cursor: pointer; width: 100%; margin-top: 10px; transition: all .2s; }
        .btn:hover { background: #16a34a; color: #fff; }
        .btn-logout { background: #ef4444; color: #fff; margin-top: 14px; }
        .btn-logout:hover { background: #dc2626; }
        .footer { margin-top: 24px; font-size: 12px; color: #64748b; }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo-wrap">
            <div class="logo-icon">💬</div>
            <div>
                <h1>विश्व हिंदी परिषद</h1>
                <p class="sub">100% मुफ़्त WhatsApp Web Gateway (Baileys)</p>
            </div>
        </div>

        <div id="status-badge" class="badge disconnected">जांच हो रही है...</div>

        <!-- QR Code Area -->
        <div id="qr-container" style="display:none">
            <div class="qr-box">
                <img id="qr-img" src="" alt="WhatsApp QR Code">
            </div>
            <div class="steps">
                <strong>📲 अपने मोबाइल से QR कोड स्कैन करें:</strong>
                <ol>
                    <li>अपने फ़ोन में <strong>WhatsApp</strong> खोलें।</li>
                    <li>ऊपर 3 डॉट्स (⋮) या <strong>Settings</strong> → <strong>Linked Devices</strong> (लिंक किए गए डिवाइस) पर टैप करें।</li>
                    <li><strong>Link a Device</strong> दबाकर इस QR कोड को स्कैन कर लें!</li>
                </ol>
            </div>
        </div>

        <!-- Connected View -->
        <div id="connected-container" style="display:none">
            <div style="background:#0f172a;border:1px solid #22c55e;border-radius:14px;padding:20px;margin-bottom:20px">
                <div style="font-size:42px;margin-bottom:8px">🎉</div>
                <h3 style="color:#4ade80;font-size:18px">WhatsApp सफलता से कनेक्ट है!</h3>
                <p style="font-size:14px;color:#cbd5e1;margin-top:6px">कनेक्टेड नंबर: <strong id="conn-phone" style="color:#fff">+91</strong></p>
                <div style="font-size:12px;color:#94a3b8;margin-top:10px">🤖 ऑटो-रिप्लाई बॉट, डिजिटल आई-कार्ड डाउनलोड व OTP सर्विस पूरी तरह सक्रिय हैं।</div>
            </div>

            <!-- Test Send Message Form -->
            <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:18px;text-align:left">
                <h4 style="font-size:14px;color:#fff;margin-bottom:10px">🧪 लाइव WhatsApp टेस्ट मैसेज भेजें:</h4>
                <div class="input-group">
                    <label>मोबाइल नंबर (10 अंक):</label>
                    <input type="text" id="test-phone" placeholder="उदा. 9818402889">
                </div>
                <div class="input-group">
                    <label>संदेश (Message):</label>
                    <textarea id="test-message" rows="3">नमस्ते! यह विश्व हिंदी परिषद की ओर से लाइव WhatsApp टेस्ट संदेश है।</textarea>
                </div>
                <button type="button" class="btn" onclick="sendTestMessage()">🚀 संदेश भेजें (Send Test)</button>
                <div id="test-result" style="font-size:12px;margin-top:8px;font-weight:bold"></div>
            </div>

            <button type="button" class="btn btn-logout" onclick="logoutWhatsApp()">🔴 WhatsApp डिस्कनेक्ट / लॉगआउट करें</button>
        </div>

        <!-- Webhook URL Configuration -->
        <div style="margin-top:20px;border-top:1px solid #334155;padding-top:16px;text-align:left">
            <label>🔗 वर्डप्रेस Webhook URL (जहाँ से बॉट आई-कार्ड ढूंढता है):</label>
            <input type="text" id="webhook-input" value="${config.webhookUrl}">
            <button type="button" class="btn" style="background:#3b82f6;color:#fff;margin-top:8px;padding:8px" onclick="saveWebhook()">💾 Webhook सुरक्षित करें</button>
        </div>

        <div class="footer">
            पोर्ट: <code>http://localhost:${PORT}</code> | स्थिति: <strong>100% ₹0 Free Forever</strong>
        </div>
    </div>

    <script>
        async function checkStatus() {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                const badge = document.getElementById('status-badge');

                if (data.connected) {
                    badge.className = 'badge connected';
                    badge.innerHTML = '🟢 कनेक्टेड (+ ' + data.phone + ')';
                    document.getElementById('connected-container').style.display = 'block';
                    document.getElementById('qr-container').style.display = 'none';
                    document.getElementById('conn-phone').innerText = '+' + data.phone;
                } else if (data.status === 'waiting_qr') {
                    badge.className = 'badge waiting_qr';
                    badge.innerHTML = '🟡 QR कोड स्कैन करें';
                    document.getElementById('connected-container').style.display = 'none';
                    document.getElementById('qr-container').style.display = 'block';
                    loadQr();
                } else {
                    badge.className = 'badge disconnected';
                    badge.innerHTML = '⚪ डिस्कनेक्टेड (शुरू हो रहा है...)';
                }
            } catch (err) {
                console.error(err);
            }
        }

        async function loadQr() {
            try {
                const res = await fetch('/qr');
                const data = await res.json();
                if (data.qr) {
                    document.getElementById('qr-img').src = data.qr;
                }
            } catch (e) {}
        }

        async function sendTestMessage() {
            const to = document.getElementById('test-phone').value;
            const message = document.getElementById('test-message').value;
            const resEl = document.getElementById('test-result');
            if (!to || !message) { alert('मोबाइल नंबर और संदेश दर्ज करें'); return; }

            resEl.style.color = '#38bdf8';
            resEl.innerText = 'संदेश भेजा जा रहा है...';

            try {
                const res = await fetch('/send-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to, message })
                });
                const data = await res.json();
                if (data.success) {
                    resEl.style.color = '#4ade80';
                    resEl.innerText = '✅ संदेश सफलतापूर्वक पहुँच गया! (Message ID: ' + data.messageId + ')';
                } else {
                    resEl.style.color = '#f87171';
                    resEl.innerText = '❌ त्रुटि: ' + (data.error || 'सफल नहीं हुआ');
                }
            } catch (e) {
                resEl.style.color = '#f87171';
                resEl.innerText = '❌ सर्वर से संपर्क नहीं हुआ: ' + e.message;
            }
        }

        async function saveWebhook() {
            const webhookUrl = document.getElementById('webhook-input').value;
            await fetch('/set-webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webhookUrl })
            });
            alert('Webhook URL सफलतापूर्वक सुरक्षित हो गया!');
        }

        async function logoutWhatsApp() {
            if (!confirm('क्या आप सचमुच WhatsApp लॉगआउट करना चाहते हैं?')) return;
            await fetch('/logout');
            checkStatus();
        }

        setInterval(checkStatus, 2500);
        checkStatus();
    </script>
</body>
</html>
    `);
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║   🏛️ विश्व हिंदी परिषद — WhatsApp Web Gateway (Baileys)          ║
║   🌐 URL: http://localhost:${PORT}                                ║
║   📌 स्थिति: 100% Free Forever (₹0 खर्च)                          ║
╚══════════════════════════════════════════════════════════════════╝
    `);
    startWhatsApp();
});
