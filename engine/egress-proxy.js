// Proxy de sortie du navigateur piloté (Lot 2).
//
// Chromium est lancé avec ce proxy (`--proxy-server`, boucle locale comprise :
// Playwright pose `<-loopback>`) : TOUT son trafic HTTP, HTTPS et WebSocket y
// passe — navigation, redirections, sous-ressources, workers, service workers,
// WebSocket ouverts par la page, y compris ceux qu'un script de page
// contournerait côté JavaScript. `context.route` (session.js) ne voit pas les
// poignées de main WebSocket et laisse Chromium refaire sa propre résolution
// DNS ; ce proxy ferme ces deux trous :
//   - chaque destination passe par le filtre (url-guard.js) ;
//   - la connexion part vers l'adresse VÉRIFIÉE, jamais vers une nouvelle
//     résolution (pas de rebinding DNS entre le contrôle et la connexion).
//
// Écoute sur 127.0.0.1, port choisi par le système, une instance par session.

import http from 'node:http';
import net from 'node:net';
import { TUNNEL_SCHEMES } from './url-guard.js';

const CONNECT_TIMEOUT_MS = 15000;
const HOP_BY_HOP = new Set([
  'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive',
  'connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** `lookup` pour net/http : renvoie toujours l'adresse déjà vérifiée. */
function pinnedLookup(address, family) {
  return (_host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (opts && opts.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function refuse(res, reason) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  res.end(`robot-lab : destination refusée — ${reason}\n`);
}

function refuseSocket(socket, reason) {
  const body = `robot-lab : destination refusée — ${reason}\n`;
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/**
 * Démarre le proxy. `guard` : createGuard() ; `onBlocked(url, reason)` : appelé
 * à chaque refus. Résout `{ server: 'http://127.0.0.1:<port>', close() }`.
 */
export async function startEgressProxy({ guard, onBlocked = () => {} }) {
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); return s; };

  const blocked = (url, reason) => {
    try { onBlocked(url, reason); } catch { /* notification seulement */ }
  };

  const server = http.createServer(async (req, res) => {
    // Requête de proxy en clair : la cible est une URI absolue.
    let target;
    try { target = new URL(req.url); } catch { refuse(res, 'requête non proxifiée'); return; }
    const verdict = await guard.check(target.href);
    if (!verdict.ok) { blocked(target.href, verdict.reason); refuse(res, verdict.reason); return; }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    // L'URI absolue fait foi (RFC 9112 § 3.2.2), pas l'en-tête Host reçu.
    headers.host = target.host;
    const upstream = http.request({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      lookup: pinnedLookup(verdict.address, verdict.family),
      agent: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    upstream.on('socket', track);
    upstream.on('response', (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(up.statusCode, up.statusMessage, out);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('délai dépassé')));
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { Connection: 'close' }); res.end(); }
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS et WebSocket (Chromium passe toujours un WebSocket par CONNECT).
  server.on('connect', async (req, clientSocket, head) => {
    track(clientSocket);
    clientSocket.on('error', () => {});
    const [hostPart, portPart] = splitHostPort(req.url);
    if (!hostPart || !portPart) { refuseSocket(clientSocket, 'cible CONNECT illisible'); return; }
    const scheme = portPart === '80' ? 'http' : 'https';
    const shown = hostPart.includes(':') ? `[${hostPart}]` : hostPart;
    const href = `${scheme}://${shown}:${portPart}/`;
    const verdict = await guard.check(href, TUNNEL_SCHEMES);
    if (!verdict.ok) { blocked(href, verdict.reason); refuseSocket(clientSocket, verdict.reason); return; }

    const upstream = track(net.connect({
      host: verdict.address, port: Number(portPart), family: verdict.family,
      timeout: CONNECT_TIMEOUT_MS,
    }));
    upstream.on('timeout', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    clientSocket.on('close', () => upstream.destroy());
  });

  // WebSocket en clair par requête absolue (Chromium utilise CONNECT, mais
  // aucune voie n'est laissée sans filtre) : refusé plutôt que relayé.
  server.on('upgrade', (req, socket) => {
    track(socket);
    socket.on('error', () => {});
    blocked(req.url, 'WebSocket hors tunnel refusé');
    refuseSocket(socket, 'WebSocket hors tunnel refusé');
  });

  server.on('connection', track);
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    server: `http://127.0.0.1:${port}`,
    port,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** « host:port », « [v6]:port » → [host, port]. */
export function splitHostPort(value) {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value || '') || /^([^:[\]]+):(\d{1,5})$/.exec(value || '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) return [null, null];
  return [m[1], m[2]];
}

/** Options de `chromium.launch` qui font passer tout le trafic par le proxy. */
export function chromiumLaunchOptions(proxy) {
  return {
    headless: true,
    // `<-loopback>` : la boucle locale passe aussi par le proxy (donc refusée).
    proxy: { server: proxy.server, bypass: '<-loopback>' },
    // WebRTC n'utilise jamais d'UDP hors proxy : pas de sonde UDP du réseau.
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  };
}

/**
 * Seconde couche, même filtre : une requête refusée échoue net
 * (ERR_BLOCKED_BY_CLIENT) au lieu de recevoir la page 403 du proxy — un `goto`
 * vers une destination refusée lève donc une erreur au lieu de « réussir ».
 */
export async function installRouteGuard(context, guard, onBlocked = () => {}) {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      await route.continue().catch(() => {});
      return;
    }
    const verdict = await guard.check(url);
    if (verdict.ok) {
      await route.continue().catch(() => {});
    } else {
      try { onBlocked(url, verdict.reason); } catch { /* notification seulement */ }
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
}
