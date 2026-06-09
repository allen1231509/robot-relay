const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '1Ep5Shk';

// ── Orion Star MQTT credentials ───────────────────────────
const ORION_TOKEN     = process.env.ORION_TOKEN     || '';
const ORION_UID       = process.env.ORION_UID       || '';
const ORION_CORP_UUID = process.env.ORION_CORP_UUID || '';
const ORION_ROBOT_ID  = process.env.ORION_ROBOT_ID  || '';

let mqttCredsCache = null;
let mqttCredsCacheTime = 0;
const CACHE_TTL = 50 * 60 * 1000; // 50 minutos

function fetchOrionMqttCreds() {
    if (mqttCredsCache && Date.now() - mqttCredsCacheTime < CACHE_TTL) {
        return Promise.resolve(mqttCredsCache);
    }
    const path = `/capi/v1/corp/mq_info?pf=h5&ctime=${Date.now()}&app_id=10001&token=${ORION_TOKEN}&uid=${ORION_UID}&_corp_uuid=${ORION_CORP_UUID}&lang=en_US`;
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'global-robotmp.orionstar.com',
            path,
            method: 'POST',
            headers: { 'Content-Length': 0 }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.data && json.data.mq) {
                        mqttCredsCache = json.data.mq;
                        mqttCredsCacheTime = Date.now();
                        resolve(json.data.mq);
                    } else {
                        reject(new Error('No mq data'));
                    }
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ── Log de eventos ────────────────────────────────────────
const eventLog = [];
function logEvent(type, message) {
    const entry = { time: new Date().toISOString(), type, message };
    eventLog.unshift(entry);
    if (eventLog.length > 100) eventLog.pop();
    console.log(`[${entry.type.toUpperCase()}] ${message}`);
}

// ── Estado ────────────────────────────────────────────────
let controllerIdCounter = 0;
const controllers = new Map();
let robotSocket = null;
let robotConnectedAt = null;
let robotIp = null;

// ── Panel de admin HTML ───────────────────────────────────
function getAdminHtml() {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robot Relay — Admin</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0a0a14; color:#fff; font-family:Arial,sans-serif; padding:20px; }
h1 { color:#00ff88; font-size:22px; margin-bottom:4px; }
.sub { color:#666688; font-size:12px; margin-bottom:24px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px; }
@media(max-width:600px){ .grid { grid-template-columns:1fr; } }
.card { background:#12121f; border:1px solid #1e1e35; border-radius:12px; padding:16px; }
.card-title { font-size:11px; color:#666688; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }
.status { display:flex; align-items:center; gap:8px; font-size:15px; margin-bottom:8px; }
.dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.dot.green { background:#00ff88; box-shadow:0 0 6px #00ff88; }
.dot.red { background:#ff4455; }
.info { font-size:12px; color:#666688; margin-top:4px; }
.controllers-list { display:flex; flex-direction:column; gap:8px; }
.ctrl-item { display:flex; align-items:center; justify-content:space-between; background:#0a0a14; border:1px solid #1e1e35; border-radius:8px; padding:10px 12px; }
.ctrl-info { font-size:13px; }
.ctrl-ip { font-size:11px; color:#666688; margin-top:2px; }
.kick-btn { padding:6px 12px; border-radius:6px; border:1px solid #ff4455; background:transparent; color:#ff4455; cursor:pointer; font-size:12px; }
.kick-btn:hover { background:#ff445522; }
.empty { color:#666688; font-size:13px; text-align:center; padding:12px 0; }
.log-list { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto; }
.log-item { font-size:12px; padding:6px 10px; border-radius:6px; background:#0a0a14; border-left:3px solid #1e1e35; }
.log-item.robot { border-left-color:#00ff88; }
.log-item.controller { border-left-color:#4488ff; }
.log-item.command { border-left-color:#ffcc00; }
.log-item.error { border-left-color:#ff4455; }
.log-time { color:#666688; font-size:10px; margin-bottom:2px; }
.refresh-btn { padding:8px 16px; border-radius:8px; border:none; background:#00ff88; color:#000; font-weight:bold; cursor:pointer; font-size:13px; margin-bottom:16px; }
.robot-kick { margin-top:10px; padding:8px 14px; border-radius:8px; border:1px solid #ff4455; background:transparent; color:#ff4455; cursor:pointer; font-size:12px; width:100%; }
.robot-kick:hover { background:#ff445522; }
</style>
</head>
<body>
<h1>🤖 Robot Relay — Admin</h1>
<div class="sub">Panel de control en tiempo real</div>
<button class="refresh-btn" onclick="loadData()">↻ Actualizar</button>
<div class="grid">
    <div class="card">
        <div class="card-title">Estado del Robot</div>
        <div id="robotStatus" class="status"><div class="dot red"></div>Cargando...</div>
        <div id="robotInfo" class="info"></div>
        <button class="robot-kick" id="robotKickBtn" onclick="kickRobot()" style="display:none">⚡ Desconectar robot</button>
    </div>
    <div class="card">
        <div class="card-title">Controladores conectados</div>
        <div id="controllersList" class="controllers-list"><div class="empty">Cargando...</div></div>
    </div>
</div>
<div class="card">
    <div class="card-title">Log de eventos (últimos 100)</div>
    <div id="logList" class="log-list"><div class="empty">Cargando...</div></div>
</div>
<script>
const ADMIN_SECRET = '${ADMIN_SECRET}';
async function loadData() {
    try {
        const res = await fetch('/admin/data?admin=' + ADMIN_SECRET);
        if (res.status === 401) { document.body.innerHTML = '<h2 style="color:red;padding:40px">❌ No autorizado</h2>'; return; }
        const data = await res.json();
        const robotDiv = document.getElementById('robotStatus');
        const robotInfo = document.getElementById('robotInfo');
        const robotKickBtn = document.getElementById('robotKickBtn');
        if (data.robot.connected) {
            robotDiv.innerHTML = '<div class="dot green"></div> Conectado';
            robotInfo.textContent = 'IP: ' + data.robot.ip + ' · Desde: ' + formatTime(data.robot.connectedAt);
            robotKickBtn.style.display = 'block';
        } else {
            robotDiv.innerHTML = '<div class="dot red"></div> Desconectado';
            robotInfo.textContent = '';
            robotKickBtn.style.display = 'none';
        }
        const list = document.getElementById('controllersList');
        if (data.controllers.length === 0) {
            list.innerHTML = '<div class="empty">No hay controladores conectados</div>';
        } else {
            list.innerHTML = data.controllers.map(c => \`<div class="ctrl-item"><div><div class="ctrl-info">🎮 Controlador #\${c.id}</div><div class="ctrl-ip">IP: \${c.ip} · Desde: \${formatTime(c.connectedAt)}</div></div><button class="kick-btn" onclick="kickController(\${c.id})">Desconectar</button></div>\`).join('');
        }
        const logList = document.getElementById('logList');
        if (data.log.length === 0) {
            logList.innerHTML = '<div class="empty">Sin eventos aún</div>';
        } else {
            logList.innerHTML = data.log.map(e => \`<div class="log-item \${e.type}"><div class="log-time">\${formatTime(e.time)}</div>\${e.message}</div>\`).join('');
        }
    } catch(err) { console.error(err); }
}
async function kickController(id) {
    await fetch('/admin/kick?admin=' + ADMIN_SECRET + '&id=' + id, { method: 'POST' });
    loadData();
}
async function kickRobot() {
    await fetch('/admin/kick-robot?admin=' + ADMIN_SECRET, { method: 'POST' });
    loadData();
}
function formatTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
loadData();
setInterval(loadData, 3000);
</script>
</body>
</html>`;
}

// ── Servidor HTTP ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    const path = url.pathname;
    const adminParam = url.searchParams.get('admin');

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ← NUEVO: credenciales MQTT de Orion
    if (path === '/orion-creds') {
        try {
            const creds = await fetchOrionMqttCreds();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                host: creds.host,
                port: parseInt(creds.port),
                user: creds.user,
                pass: creds.pass,
                clientId: creds.cuid,
                robotId: ORION_ROBOT_ID
            }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // Panel admin
    if (path === '/admin') {
        if (adminParam !== ADMIN_SECRET) { res.writeHead(401); res.end('No autorizado'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getAdminHtml());
        return;
    }

    // API datos admin
    if (path === '/admin/data') {
        if (adminParam !== ADMIN_SECRET) { res.writeHead(401); res.end('No autorizado'); return; }
        const data = {
            robot: { connected: robotSocket !== null && robotSocket.readyState === WebSocket.OPEN, ip: robotIp, connectedAt: robotConnectedAt },
            controllers: Array.from(controllers.entries()).map(([id, c]) => ({ id, ip: c.ip, connectedAt: c.connectedAt })),
            log: eventLog
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // Kick controlador
    if (path === '/admin/kick' && req.method === 'POST') {
        if (adminParam !== ADMIN_SECRET) { res.writeHead(401); res.end('No autorizado'); return; }
        const id = parseInt(url.searchParams.get('id'));
        const ctrl = controllers.get(id);
        if (ctrl) {
            ctrl.ws.close(1008, 'Desconectado por admin');
            controllers.delete(id);
            logEvent('controller', `Controlador #${id} desconectado por admin`);
        }
        res.writeHead(200); res.end('ok');
        return;
    }

    // Kick robot
    if (path === '/admin/kick-robot' && req.method === 'POST') {
        if (adminParam !== ADMIN_SECRET) { res.writeHead(401); res.end('No autorizado'); return; }
        if (robotSocket) {
            robotSocket.close(1008, 'Desconectado por admin');
            logEvent('robot', 'Robot desconectado por admin');
        }
        res.writeHead(200); res.end('ok');
        return;
    }

    // Status básico
    if (path === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ robotConnected: robotSocket !== null && robotSocket.readyState === WebSocket.OPEN, controllers: controllers.size }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Robot Relay Server running');
});

// ── WebSocket ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost`);
    const type = url.searchParams.get('type');
    const secret = url.searchParams.get('secret');
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'desconocida';

    if (secret !== process.env.SECRET || !secret) {
        logEvent('error', `Conexión rechazada desde ${ip}: secret inválido`);
        ws.close(1008, 'Unauthorized');
        return;
    }

    if (type === 'robot') {
        robotSocket = ws;
        robotIp = ip;
        robotConnectedAt = new Date().toISOString();
        logEvent('robot', `✅ Robot conectado desde ${ip}`);
        controllers.forEach(({ ws: ctrl }) => { if (ctrl.readyState === WebSocket.OPEN) ctrl.send(JSON.stringify({ status: 'robot_connected' })); });
        ws.on('message', (data) => {
            const message = data.toString();
            controllers.forEach(({ ws: ctrl }) => { if (ctrl.readyState === WebSocket.OPEN) ctrl.send(message); });
        });
        ws.on('close', () => {
            logEvent('robot', '❌ Robot desconectado');
            robotSocket = null; robotIp = null; robotConnectedAt = null;
            controllers.forEach(({ ws: ctrl }) => { if (ctrl.readyState === WebSocket.OPEN) ctrl.send(JSON.stringify({ status: 'robot_disconnected' })); });
        });
        ws.on('error', (err) => logEvent('error', `Robot WS error: ${err.message}`));

    } else if (type === 'controller') {
        const id = ++controllerIdCounter;
        controllers.set(id, { ws, ip, connectedAt: new Date().toISOString() });
        logEvent('controller', `📱 Controlador #${id} conectado desde ${ip}`);
        if (robotSocket && robotSocket.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ status: 'robot_connected' }));
        else ws.send(JSON.stringify({ status: 'robot_disconnected' }));
        ws.on('message', (data) => {
            const message = data.toString();
            try { const json = JSON.parse(message); if (json.action) logEvent('command', `📨 Controlador #${id}: ${json.action}`); } catch(_) {}
            if (robotSocket && robotSocket.readyState === WebSocket.OPEN) robotSocket.send(message);
            else ws.send(JSON.stringify({ status: 'error', message: 'Robot no conectado' }));
        });
        ws.on('close', () => { controllers.delete(id); logEvent('controller', `📱 Controlador #${id} desconectado`); });
        ws.on('error', (err) => logEvent('error', `Controller #${id} WS error: ${err.message}`));
    } else {
        ws.close(1008, 'type inválido');
    }
});

server.listen(PORT, () => { logEvent('robot', `🚀 Relay server corriendo en puerto ${PORT}`); });
