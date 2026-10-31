// node --test : le proxy de sortie, avec DNS simulé. Les seules connexions
// réellement ouvertes vont vers un serveur de test sur 127.0.0.2, que le filtre
// de CE test autorise explicitement ; toute destination interne est refusée
// avant connexion (le serveur « interne » compte les connexions reçues : zéro).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { startEgressProxy, splitHostPort } from '../egress-proxy.js';
import { createGuard, isForbiddenAddress } from '../url-guard.js';

const PUBLIC_IP = '127.0.0.2';   // tient lieu d'« Internet » dans ce test
let publicServer; let publicPort;
let internalServer; let internalPort; let internalHits = 0;
let proxy; const blocked = [];

const ZONE = {
  'public.test': [PUBLIC_IP],
  'redirige.test': [PUBLIC_IP],
  'interne.test': ['127.0.0.1'],
  'mixte.test': [PUBLIC_IP, '10.0.0.1'],
};
const lookup = async (host) => {
  const list = ZONE[host];
  if (!list) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return list.map((address) => ({ address, family: 4 }));
};
const isForbidden = (ip) => (ip === PUBLIC_IP ? false : isForbiddenAddress(ip));

before(async () => {
  publicServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://interne.test:${internalPort}/` });
      res.end();
      return;
    }
    res.end(`public ${req.headers.host} ${req.url}`);
  });
  await new Promise((r) => publicServer.listen(0, PUBLIC_IP, r));
  publicPort = publicServer.address().port;
  internalServer = net.createServer((s) => { internalHits++; s.destroy(); });
  await new Promise((r) => internalServer.listen(0, '127.0.0.1', r));
  internalPort = internalServer.address().port;
  proxy = await startEgressProxy({
    guard: createGuard({ lookup, isForbidden }),
    onBlocked: (url, reason) => blocked.push({ url, reason }),
  });
});
after(async () => {
  await proxy.close();
  publicServer.close();
  internalServer.close();
});

function viaProxy(absoluteUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: absoluteUrl, method: 'GET' });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP vers une destination publique : relayé vers l\'adresse vérifiée', async () => {
  const r = await viaProxy(`http://public.test:${publicPort}/page?x=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body, `public public.test:${publicPort} /page?x=1`);
});

test('HTTP vers un service interne : 403, aucune connexion', async () => {
  for (const url of [
    'http://code-server:8091/', `http://interne.test:${internalPort}/`, `http://127.0.0.1:${internalPort}/`,
    `http://localhost:${internalPort}/`, `http://[::1]:${internalPort}/`,
    `http://[::ffff:127.0.0.1]:${internalPort}/`, 'http://10.0.0.1/', `http://mixte.test:${publicPort}/`,
  ]) {
    const r = await viaProxy(url);
    assert.equal(r.status, 403, url);
  }
  assert.equal(internalHits, 0);
});

test('redirection 302 vers une IP interne : la redirection passe, la cible est refusée', async () => {
  const r = await viaProxy(`http://redirige.test:${publicPort}/redirect`);
  assert.equal(r.status, 302);
  const suite = await viaProxy(r.headers.location);
  assert.equal(suite.status, 403);
  assert.equal(internalHits, 0);
});

test('CONNECT (HTTPS, WebSocket) : public accepté, interne refusé', async () => {
  assert.equal(await connectVia(`public.test:${publicPort}`), 200);
  for (const t of ['code-server:8091', `interne.test:${internalPort}`, `127.0.0.1:${internalPort}`,
    `localhost:${internalPort}`, `[::1]:${internalPort}`, '10.0.0.1:443', `[::ffff:7f00:1]:${internalPort}`,
    'pas-de-port', 'public.test:99999']) {
    assert.equal(await connectVia(t), 403, t);
  }
  assert.equal(internalHits, 0);
});

test('requête non proxifiée (chemin relatif) refusée', async () => {
  const r = await viaProxy('/healthz');
  assert.equal(r.status, 403);
});

test('les refus sont signalés', () => {
  assert.ok(blocked.length > 0);
  assert.ok(blocked.every((b) => b.reason));
});

test('splitHostPort', () => {
  assert.deepEqual(splitHostPort('example.org:443'), ['example.org', '443']);
  assert.deepEqual(splitHostPort('[::1]:80'), ['::1', '80']);
  assert.deepEqual(splitHostPort('example.org'), [null, null]);
  assert.deepEqual(splitHostPort('example.org:0'), [null, null]);
});
