/**
 * VisionIA — Servidor optimizado
 * ─────────────────────────────
 * • WebSocket nativo (ws) para latencia mínima desde iPhone
 * • HTTP POST clásico como fallback (JSON + FormData)
 * • SSE hacia el monitor (sin cambios de interfaz)
 * • Sin dependencia de Cloudflare — compatible con cualquier túnel:
 *     npx localtunnel --port 3000
 *     cloudflared tunnel --url http://localhost:3000
 *     ngrok http 3000
 *
 * Instalar: npm install express ws multer cors
 * Correr:   node server.js
 */

const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const multer   = require('multer');
const { WebSocketServer } = require('ws');
const path     = require('path');
const fs       = require('fs');

// ── CONFIG ─────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const MAX_USERS = 2;

// ── APP ────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.static(__dirname));
// CORS amplio — necesario para acceso desde cualquier dominio/túnel
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','ngrok-skip-browser-warning','x-tunnel-id'],
}));
app.options('*', cors());

// Body parsers — límite 15 MB para imágenes en base64
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Servir la página del iPhone estáticamente
app.use('/cam', express.static(path.join(__dirname, 'iphone.html')));
// También desde raíz para QRs cortos
app.get('/cam', (req, res) => {
  res.sendFile(path.join(__dirname, 'iphone.html'));
});

// Servir monitor
app.get('/monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

// multer en memoria para FormData (no escribe a disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ── ESTADO ─────────────────────────────────────────
const monitors = { 1: new Set(), 2: new Set() }; // SSE clients
const stats    = { 1: { rcv:0 }, 2: { rcv:0 } };
const wsClients = { 1: new Set(), 2: new Set() };

// ── WEBSOCKET ──────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const userStr = url.searchParams.get('user');
  const u      = (userStr === '2') ? 2 : 1;

  wsClients[u].add(ws);
  console.log(`[WS] iPhone conectado → Usuario ${u} (${wsClients[u].size} activos)`);

  ws.send(JSON.stringify({ type: 'connected', user: u }));

  ws.on('message', async (raw) => {
    try {
      // Esperamos JSON con { user, ts, mime, sizeKB, deviceName, data }
      const msg = JSON.parse(raw.toString());
      const frameData = buildFrameFromJSON(msg);
      if(!frameData) return;

      stats[u].rcv++;
      broadcastToMonitors(u, frameData);
      ws.send(JSON.stringify({ ok: true, ts: Date.now() }));
    } catch(e) {
      console.error('[WS] Error procesando frame:', e.message);
    }
  });

  ws.on('close', () => {
    wsClients[u].delete(ws);
    console.log(`[WS] iPhone desconectado — Usuario ${u}`);
  });

  ws.on('error', (e) => {
    console.error('[WS] Error:', e.message);
    wsClients[u].delete(ws);
  });
});

// ── HTTP POST /upload/:user — JSON ─────────────────
app.post('/upload/:user', async (req, res) => {
  const u = parseInt(req.params.user);
  if(u !== 1 && u !== 2) return res.status(400).json({ error: 'Usuario inválido' });

  try {
    let frameData;

    // Detectar si viene como JSON (data en base64) o formData
    const ct = req.headers['content-type'] || '';
    if(ct.includes('application/json')) {
      frameData = buildFrameFromJSON(req.body);
    } else {
      // No debería llegar aquí con el cliente optimizado, pero como fallback:
      return res.status(400).json({ error: 'Usa JSON o FormData' });
    }

    if(!frameData) return res.status(400).json({ error: 'Datos inválidos' });

    stats[u].rcv++;
    broadcastToMonitors(u, frameData);

    // Respuesta mínima para reducir latencia
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: true }));
  } catch(e) {
    console.error('[HTTP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── HTTP POST /upload/:user — FormData ─────────────
app.post('/upload/:user/form', upload.single('image'), async (req, res) => {
  const u = parseInt(req.params.user);
  if(u !== 1 && u !== 2) return res.status(400).json({ error: 'Usuario inválido' });

  try {
    if(!req.file) return res.status(400).json({ error: 'Sin imagen' });

    const buf  = req.file.buffer;
    const mime = req.file.mimetype || 'image/jpeg';
    const b64  = buf.toString('base64');
    const kb   = Math.round(buf.byteLength / 1024);

    const frameData = {
      ts:         Date.now(),
      mime,
      sizeKB:     kb,
      deviceName: req.body.deviceName || 'iPhone',
      dataUrl:    `data:${mime};base64,${b64}`,
      mimeType:   mime,
    };

    stats[u].rcv++;
    broadcastToMonitors(u, frameData);
    res.end(JSON.stringify({ ok: true }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SSE /events/:user ──────────────────────────────
app.get('/events/:user', (req, res) => {
  const u = parseInt(req.params.user);
  if(u !== 1 && u !== 2) return res.status(400).end();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx
  res.flushHeaders();

  monitors[u].add(res);
  sseWrite(res, 'connected', { user: u });
  console.log(`[SSE] Monitor conectado → Usuario ${u} (${monitors[u].size} activos)`);

  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch(e) {}
  }, 20000);

  req.on('close', () => {
    monitors[u].delete(res);
    clearInterval(heartbeat);
  });
});

// ── STATUS ─────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    monitors: { 1: monitors[1].size, 2: monitors[2].size },
    wsClients: { 1: wsClients[1].size, 2: wsClients[2].size },
    stats,
  });
});

// ── QR helper — genera URL con parámetros ──────────
app.get('/qr/:user', (req, res) => {
  const u    = req.params.user === '2' ? 2 : 1;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT;
  const proto= req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${host}`;
  const camUrl = `${base}/cam?srv=${encodeURIComponent(base)}&u=${u}`;
  // Devolver como texto plano para escanear con herramientas externas
  res.setHeader('Content-Type', 'text/plain');
  res.end(camUrl + '\n\nEscanea con iPhone → Safari abre la cámara optimizada');
});

// ── HELPERS ────────────────────────────────────────
function buildFrameFromJSON(body) {
  if(!body || !body.data) return null;
  const mime    = body.mime || 'image/jpeg';
  const b64     = body.data;
  const kb      = body.sizeKB || Math.round(b64.length * 0.75 / 1024);
  return {
    ts:         body.ts || Date.now(),
    mime,
    sizeKB:     kb,
    deviceName: body.deviceName || 'iPhone',
    dataUrl:    `data:${mime};base64,${b64}`,
    mimeType:   mime,
  };
}

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch(e) {}
}

function broadcastToMonitors(u, frameData) {
  monitors[u].forEach(res => sseWrite(res, 'frame', frameData));
  console.log(`[FRAME] U${u} → ${frameData.sizeKB}KB → ${monitors[u].size} monitores`);
}

// ── START ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  VisionIA Server — Puerto ${PORT}               ║
╠══════════════════════════════════════════════╣
║  Monitor  →  http://localhost:${PORT}/monitor   ║
║  Cámara   →  http://localhost:${PORT}/cam        ║
║  Status   →  http://localhost:${PORT}/status     ║
║  QR U1    →  http://localhost:${PORT}/qr/1       ║
║  QR U2    →  http://localhost:${PORT}/qr/2       ║
╠══════════════════════════════════════════════╣
║  Para internet sin misma WiFi:               ║
║  npx localtunnel --port ${PORT}                 ║
║  → El iPhone se conecta desde cualquier red  ║
╚══════════════════════════════════════════════╝
`);
});
