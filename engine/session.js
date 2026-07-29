import { chromium } from 'playwright';
import { captureInit } from './capture-script.js';

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://robot-lab-backend:8000';
const ENGINE_KEY = process.env.ENGINE_INTERNAL_KEY || '';
const VIEWPORT = { width: 1280, height: 800 };

async function verifyTicket(token) {
  // Un backend lent/injoignable ne doit jamais bloquer `busy` indéfiniment —
  // fetch() n'a pas de timeout par défaut, on en pose un explicitement.
  const res = await fetch(`${BACKEND_URL}/api/internal/verify-ticket/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Engine-Key': ENGINE_KEY },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Ticket refusé (${res.status})`);
  }
  return res.json();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} : délai dépassé`)), ms)),
  ]);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Lancement du navigateur + navigation initiale — borné dans le temps : un
 * ticket vérifié mais un backend/site de départ qui traîne ne doit jamais
 * laisser `busy` bloqué indéfiniment côté server.js. */
async function setup(ws, token, steps) {
  const { start_url: startUrl } = await verifyTicket(token);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.exposeFunction('__robotLabRecord__', (step) => {
    steps.push(step);
    send(ws, { type: 'step', step });
  });
  await page.addInitScript(captureInit);

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const step = { action: 'goto', url: frame.url() };
    steps.push(step);
    send(ws, { type: 'step', step });
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    send(ws, { type: 'frame', data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  send(ws, { type: 'ready', startUrl });

  return { browser, cdp, page };
}

/** Une session = un ticket = un navigateur. Ferme tout proprement dans tous les cas. */
export async function runSession(ws, token) {
  let browser = null;
  let cdp = null;
  const steps = [];

  try {
    const setupResult = await withTimeout(setup(ws, token, steps), 20000, 'Initialisation de la session');
    browser = setupResult.browser;
    cdp = setupResult.cdp;
    const page = setupResult.page;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleClientMessage(page, ws, msg, steps).catch((err) => {
        send(ws, { type: 'error', message: String(err.message || err) });
      });
    });

    await new Promise((resolve) => {
      ws.once('close', resolve);
      ws.once('robotlab:stop', resolve);
    });
  } catch (err) {
    send(ws, { type: 'error', message: String(err.message || err) });
  } finally {
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
    if (browser) await browser.close().catch(() => {});
    try { ws.close(1000, 'session ended'); } catch { /* déjà fermée */ }
  }
}

async function handleClientMessage(page, ws, msg, steps) {
  switch (msg.type) {
    case 'mouse':
      if (msg.action === 'move') await page.mouse.move(msg.x, msg.y);
      else if (msg.action === 'down') await page.mouse.down({ button: msg.button || 'left' });
      else if (msg.action === 'up') await page.mouse.up({ button: msg.button || 'left' });
      return;
    case 'wheel':
      await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
      return;
    case 'key':
      if (msg.action === 'down') await page.keyboard.down(msg.key);
      else if (msg.action === 'up') await page.keyboard.up(msg.key);
      return;
    case 'type':
      await page.keyboard.insertText(msg.text || '');
      return;
    case 'stop':
      send(ws, { type: 'final', steps });
      ws.emit('robotlab:stop');
      return;
    default:
      // message inconnu : ignoré, pas une erreur (protocole ouvert à extension).
  }
}
