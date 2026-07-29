import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { runSession } from './session.js';

const PORT = 4300;

const app = express();

// Un seul run à la fois — même principe que runner/server.js (contrainte
// 2 vCPU/16 Go du serveur, cf. CLAUDE.md) : recording et (plus tard) exécution
// partagent ce mutex, robot-lab n'a besoin que d'un navigateur à la fois.
let busy = false;

app.get('/healthz', (_req, res) => res.json({ ok: true, busy }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('ticket');
  if (!token) {
    socket.destroy();
    return;
  }
  if (busy) {
    // 409-like : pas de code HTTP à ce stade de l'upgrade, on referme juste.
    socket.destroy();
    return;
  }
  // Posé ici, pas dans le handler 'connection' : réduit la fenêtre de course
  // entre deux upgrades simultanés qui liraient tous deux `busy === false`.
  busy = true;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, token);
  });
});

wss.on('connection', async (ws, token) => {
  try {
    await runSession(ws, token);
  } finally {
    busy = false;
  }
});

server.listen(PORT, () => console.log(`robot-lab-engine en écoute sur :${PORT}`));
