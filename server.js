const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            robotConnected: robotSocket !== null && robotSocket.readyState === WebSocket.OPEN,
            controllers: controllers.size
        }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Robot Relay Server running');
});

const wss = new WebSocket.Server({ server });

let robotSocket = null;
const controllers = new Set();

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost`);
    const type = url.searchParams.get('type');
    const secret = url.searchParams.get('secret');

    if (secret !== process.env.SECRET || !secret) {
        console.log(`Conexión rechazada: secret inválido`);
        ws.close(1008, 'Unauthorized');
        return;
    }

    if (type === 'robot') {
        robotSocket = ws;
        console.log('✅ Robot conectado');
        controllers.forEach(ctrl => {
            if (ctrl.readyState === WebSocket.OPEN) {
                ctrl.send(JSON.stringify({ status: 'robot_connected' }));
            }
        });
        ws.on('message', (data) => {
            controllers.forEach(ctrl => {
                if (ctrl.readyState === WebSocket.OPEN) {
                    ctrl.send(data);
                }
            });
        });
        ws.on('close', () => {
            console.log('❌ Robot desconectado');
            robotSocket = null;
            controllers.forEach(ctrl => {
                if (ctrl.readyState === WebSocket.OPEN) {
                    ctrl.send(JSON.stringify({ status: 'robot_disconnected' }));
                }
            });
        });
        ws.on('error', (err) => console.error('Robot WS error:', err.message));

    } else if (type === 'controller') {
        controllers.add(ws);
        console.log(`📱 Controlador conectado (total: ${controllers.size})`);
        if (robotSocket && robotSocket.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'robot_connected' }));
        } else {
            ws.send(JSON.stringify({ status: 'robot_disconnected' }));
        }
        ws.on('message', (data) => {
            if (robotSocket && robotSocket.readyState === WebSocket.OPEN) {
                robotSocket.send(data);
            } else {
                ws.send(JSON.stringify({ status: 'error', message: 'Robot no conectado' }));
            }
        });
        ws.on('close', () => {
            controllers.delete(ws);
            console.log(`📱 Controlador desconectado (total: ${controllers.size})`);
        });
        ws.on('error', (err) => console.error('Controller WS error:', err.message));

    } else {
        ws.close(1008, 'type inválido — usa ?type=robot o ?type=controller');
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Relay server corriendo en puerto ${PORT}`);
});
