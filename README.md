# VisionIA v2 — Guía rápida

## Estructura
```
visionia/
├── server.js          ← Servidor Node.js (WS + HTTP)
├── iphone.html        ← Página de cámara para iPhone (Safari)
├── monitor.html       ← Monitor desktop
└── package.json
```

## 1. Instalar y arrancar

```bash
npm install
node server.js
```

## 2. Acceso desde iPhone (fuera de la misma WiFi)

Elige un túnel (todos gratuitos, sin cuenta requerida con localtunnel):

```bash
# Opción A — Sin cuenta (más fácil)
npx localtunnel --port 3000

# Opción B — Cloudflare
cloudflared tunnel --url http://localhost:3000

# Opción C — ngrok (requiere cuenta gratuita)
ngrok http 3000
```

El túnel te dará una URL pública tipo `https://abc123.loca.lt`

## 3. Conectar iPhone

**Opción A — QR automático:**
En el monitor, conecta el servidor con la URL del túnel → aparecen botones
"Abrir cám U1 / U2" que abren la página en Safari.

**Opción B — URL directa:**
En Safari del iPhone ve a:
```
https://TU-TUNEL.loca.lt/cam?srv=https://TU-TUNEL.loca.lt&u=1
```

## 4. Protocolo de transferencia

| Situación | Protocolo recomendado |
|-----------|----------------------|
| iPhone → Server (principal) | **WebSocket** — latencia ~5-20ms |
| Fallback / compatibilidad | **HTTP POST JSON** |
| Imágenes >80 KB | HTTP FormData (automático) |

## 5. Ajustes de rendimiento

- **Intervalo**: 200 ms (5fps) hasta 5 s
- **Calidad**: Ultra/Alta/Media/Rápida — compresión JPEG adaptativa
- **Compresión adaptativa**: si el frame pasa de 150 KB, la calidad baja automáticamente
- **Sin cola**: el monitor recibe y analiza en paralelo sin esperar

## 6. Puertos y rutas

| Ruta | Descripción |
|------|-------------|
| `GET /monitor` | Monitor desktop |
| `GET /cam?srv=URL&u=1` | Cámara iPhone |
| `WS /ws?user=1` | WebSocket frames |
| `POST /upload/1` | HTTP POST JSON |
| `POST /upload/1/form` | HTTP POST FormData |
| `GET /events/1` | SSE → Monitor |
| `GET /status` | Estado del servidor |
| `GET /qr/1` | URL para el QR |
