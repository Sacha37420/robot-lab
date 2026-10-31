// node --test : le filtre avec un VRAI Chromium (Playwright), hors service.
// Ignoré si aucun navigateur n'est lançable (dépendance absente).
//
// « Internet » = un serveur de test sur 127.0.0.2, nommé public.test par le DNS
// simulé du filtre et autorisé par le seul filtre de ce test. Le « service
// interne » écoute sur 127.0.0.1 et compte les connexions : il ne doit en
// recevoir aucune. Aucune adresse du lab n'est jamais ouverte : code-server,
// 10.0.0.1… sont refusés avant toute connexion.
//
//   PLAYWRIGHT_MODULE=/chemin/vers/playwright-core node --test test/
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { chromiumLaunchOptions, installRouteGuard, startEgressProxy } from '../egress-proxy.js';
import { assertNavigable, createGuard, isForbiddenAddress } from '../url-guard.js';

const PUBLIC_IP = '127.0.0.2';
let chromium = null;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch { /* ignoré plus bas */ }

let publicServer; let P; let internal; let I; let internalHits = 0;
let proxy; let browser; let context; const blocked = [];

const ZONE = { 'public.test': [PUBLIC_IP], 'interne.test': ['127.0.0.1'] };
const lookup = async (host) => {
  if (!ZONE[host]) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return ZONE[host].map((address) => ({ address, family: 4 }));
};
const isForbidden = (ip) => (ip === PUBLIC_IP ? false : isForbiddenAddress(ip));

const PAGE = (body) => `<!doctype html><title>t</title><body>${body}</body>`;

before(async () => {
  publicServer = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect?to=')) {
      res.writeHead(302, { Location: decodeURIComponent(req.url.slice('/redirect?to='.length)) });
      res.end();
      return;
    }
    if (req.url === '/worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`onmessage = (e) => { const ws = new WebSocket(e.data);
        ws.onopen = () => postMessage('open'); ws.onerror = () => postMessage('error'); };`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE(`public ${req.url}`));
  });
  const wss = new WebSocketServer({ server: publicServer });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  await new Promise((r) => publicServer.listen(0, PUBLIC_IP, r));
  P = publicServer.address().port;
  internal = net.createServer((s) => { internalHits++; s.destroy(); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  I = internal.address().port;

  if (!chromium) return;
  const guard = createGuard({ lookup, isForbidden });
  proxy = await startEgressProxy({ guard, onBlocked: (u, r) => blocked.push([u, r]) });
  try {
    browser = await chromium.launch(chromiumLaunchOptions(proxy));
  } catch {
    browser = null;
    return;
  }
  context = await browser.newContext();
  await installRouteGuard(context, guard, (u, r) => blocked.push([u, r]));
});

after(async () => {
  if (browser) await browser.close();
  if (proxy) await proxy.close();
  publicServer.close(); internal.close();
});


async function gotoFails(page, url) {
  try {
    await page.goto(url, { timeout: 10000 });
  } catch (err) {
    return String(err.message);
  }
  return null;
}

test('page publique : chargée', async (t) => {
  if (!browser) { t.skip('aucun Chromium lançable'); return; }
  const page = await context.newPage();
  const r = await page.goto(`http://public.test:${P}/ok`);
  assert.equal(r.status(), 200);
  assert.match(await page.textContent('body'), /public \/ok/);
  await page.close();
});

test('goto vers un service interne : refusé, aucune connexion', async (t) => {
  if (!browser) { t.skip('aucun Chromium lançable'); return; }
  const page = await context.newPage();
  for (const url of [
    'http://code-server:8091/', 'http://10.0.0.1/', `http://localhost:${I}/`,
    `http://127.0.0.1:${I}/`, `http://[::1]:${I}/`, `http://[::ffff:127.0.0.1]:${I}/`,
    `http://interne.test:${I}/`,
  ]) {
    assert.ok(await gotoFails(page, url), url);
  }
  assert.equal(internalHits, 0);
  await page.close();
});

test('file:///etc/passwd : refusé avant goto', () => {
  assert.throws(() => assertNavigable('file:///etc/passwd'));
  assert.throws(() => assertNavigable('file:///proc/self/environ'));
  assert.doesNotThrow(() => assertNavigable('https://example.org/'));
});

test('hôte public qui redirige (302) vers une IP privée ou code-server : refusé', async (t) => {
  if (!browser) { t.skip('aucun Chromium lançable'); return; }
  // Constat : Playwright ne rappelle PAS context.route pour les étapes d'une
  // redirection. C'est le proxy de sortie qui refuse la cible : la navigation
  // aboutit sur sa page 403, sans aucune connexion vers la cible.
  const page = await context.newPage();
  for (const target of [
    'http://10.0.0.1/', 'http://code-server:8091/', `http://127.0.0.1:${I}/`,
    `http://interne.test:${I}/`, `http://localhost:${I}/`, `http://[::ffff:127.0.0.1]:${I}/`,
  ]) {
    let status = null; let text = '';
    try {
      const r = await page.goto(`http://public.test:${P}/redirect?to=${encodeURIComponent(target)}`,
        { timeout: 10000 });
      status = r.status();
      text = await page.textContent('body');
    } catch (err) {
      status = 'erreur';
    }
    assert.ok(status === 'erreur' || (status === 403 && /destination refusée/.test(text)),
      `${target} : ${status} ${text}`);
  }
  assert.equal(internalHits, 0);
  await page.close();
});

test('sous-ressources et fetch de la page vers l\'interne : refusés', async (t) => {
  if (!browser) { t.skip('aucun Chromium lançable'); return; }
  const page = await context.newPage();
  await page.goto(`http://public.test:${P}/ok`);
  const results = await page.evaluate(async ([I]) => {
    const out = [];
    for (const u of [`http://interne.test:${I}/`, 'http://code-server:8091/', `http://127.0.0.1:${I}/`]) {
      try { await fetch(u, { mode: 'no-cors' }); out.push('ok'); } catch { out.push('refusé'); }
    }
    await new Promise((r) => {
      const img = new Image(); img.onload = r; img.onerror = r; img.src = `http://127.0.0.1:${I}/x.png`;
    });
    return out;
  }, [I]);
  assert.deepEqual(results, ['refusé', 'refusé', 'refusé']);
  assert.equal(internalHits, 0);
  await page.close();
});

test('WebSocket : public ouvert, interne refusé — depuis la page et depuis un Worker', async (t) => {
  if (!browser) { t.skip('aucun Chromium lançable'); return; }
  const page = await context.newPage();
  await page.goto(`http://public.test:${P}/ok`);
  const fromPage = await page.evaluate(async ([P, I]) => {
    const tryWs = (u) => new Promise((resolve) => {
      const ws = new WebSocket(u);
      ws.onopen = () => { ws.send('x'); };
      ws.onmessage = (e) => { resolve(String(e.data)); ws.close(); };
      ws.onerror = () => resolve('refusé');
      setTimeout(() => resolve('délai'), 8000);
    });
    return [
      await tryWs(`ws://public.test:${P}/`),
      await tryWs(`ws://interne.test:${I}/`),
      await tryWs(`ws://127.0.0.1:${I}/`),
      await tryWs('ws://code-server:8091/'),
    ];
  }, [P, I]);
  assert.deepEqual(fromPage, ['echo:x', 'refusé', 'refusé', 'refusé']);

  const fromWorker = await page.evaluate(async ([P, I]) => {
    const run = (u) => new Promise((resolve) => {
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.postMessage(u);
      setTimeout(() => resolve('délai'), 8000);
    });
    return [await run(`ws://public.test:${P}/`), await run(`ws://127.0.0.1:${I}/`), await run('ws://code-server:8091/')];
  }, [P, I]);
  assert.deepEqual(fromWorker, ['open', 'error', 'error']);
  assert.equal(internalHits, 0);
  await page.close();
});
