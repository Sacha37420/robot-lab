import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { runAiTask } from './ai-pilot.js';
import { captureInit } from './capture-script.js';
import { describe, expand, runStep } from './replay.js';

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://robot-lab-backend:8000';
const ENGINE_KEY = process.env.ENGINE_INTERNAL_KEY || '';
const DOWNLOAD_ROOT = process.env.ROBOT_DOWNLOAD_ROOT || '/downloads';
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

/** Lancement du navigateur + vue live. Borné dans le temps : un ticket vérifié
 * mais un backend/site de départ qui traîne ne doit jamais laisser `busy`
 * bloqué indéfiniment côté server.js. */
async function setup(ws, token, steps) {
  const ticket = await verifyTicket(token);
  const isRun = ticket.mode === 'run';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    acceptDownloads: isRun,
  });
  const page = await context.newPage();

  if (isRun) {
    await attachDownloads(context, page, ws, ticket.run_id);
  } else {
    // Capture des actions : uniquement en enregistrement. Pendant une exécution
    // il n'y a pas d'utilisateur qui agit, et réenregistrer ce que le robot fait
    // lui-même ne servirait qu'à polluer le parcours.
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
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    send(ws, { type: 'frame', data });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });

  await page.goto(ticket.start_url, { waitUntil: 'domcontentloaded' });
  send(ws, { type: 'ready', startUrl: ticket.start_url, mode: ticket.mode });

  return { browser, cdp, page, ticket };
}

/** Écrit les téléchargements du robot dans le dossier du run, et signale chaque
 * fichier au client — qui va le récupérer via Django (qui le supprime ensuite).
 *
 * `download` est un évènement de **Page**, pas de BrowserContext (vérifié : un
 * listener posé sur le contexte ne se déclenche jamais). On l'attache donc à
 * chaque page — celle d'origine et toute page ouverte ensuite, un clic pouvant
 * ouvrir un onglet qui déclenche le téléchargement. */
async function attachDownloads(context, page, ws, runId) {
  const directory = path.join(DOWNLOAD_ROOT, String(runId));
  await fs.mkdir(directory, { recursive: true });

  const onDownload = (download) => {
    (async () => {
      // Le nom vient du site distant : on ne garde que le nom de base, et le
      // chemin final est recomposé — jamais de concaténation du nom brut.
      const suggested = path.basename(download.suggestedFilename() || 'fichier');
      const safe = suggested.replace(/[/\\]/g, '_') || 'fichier';
      const target = path.join(directory, await uniqueName(directory, safe));

      try {
        await download.saveAs(target);
        const { size } = await fs.stat(target);
        send(ws, { type: 'download', name: path.basename(target), size });
      } catch (err) {
        send(ws, { type: 'error', message: `Téléchargement échoué : ${err.message || err}` });
      }
    })();
  };

  page.on('download', onDownload);
  context.on('page', (opened) => opened.on('download', onDownload));
}

/** Évite qu'un second fichier du même nom écrase le premier. */
async function uniqueName(directory, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    try {
      await fs.access(path.join(directory, candidate));
    } catch {
      return candidate;   // n'existe pas encore
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/** Rejoue le parcours enregistré, en signalant chaque étape au client. */
async function replay(ws, page, ticket) {
  let plan;
  try {
    plan = expand(ticket.steps || [], ticket.variables || {});
  } catch (err) {
    send(ws, { type: 'error', message: String(err.message || err) });
    return;
  }

  send(ws, { type: 'plan', total: plan.length });

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    send(ws, { type: 'progress', index: i + 1, total: plan.length, label: describe(step) });
    try {
      if (step.action === 'ai_task') {
        const outcome = await runAiTask(page, step, {
          runId: ticket.run_id,
          maxIterations: ticket.max_ai_iterations,
          report: (payload) => send(ws, payload),
        });
        if (!outcome.ok) throw new Error(outcome.note);
        send(ws, { type: 'ai_done', note: outcome.note });
      } else {
        // runStep renvoie une note quand il a dû s'écarter du chemin nominal
        // (saisie frappe par frappe, liste masquée forcée…) : on la remonte
        // plutôt que de laisser croire à une exécution parfaitement nominale.
        const note = await runStep(page, step);
        if (note) send(ws, { type: 'note', index: i + 1, note });
      }
    } catch (err) {
      // On arrête au premier échec : continuer sur une page qui n'est pas celle
      // attendue enchaîne des erreurs sans rapport et masque la vraie cause.
      send(ws, {
        type: 'failed',
        index: i + 1,
        label: describe(step),
        message: String(err.message || err),
      });
      return;
    }
  }

  // Laisse le temps à un téléchargement déclenché par la dernière étape d'arriver.
  await page.waitForTimeout(1500);
  send(ws, { type: 'finished', total: plan.length });
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
    const { page, ticket } = setupResult;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleClientMessage(page, ws, msg, steps).catch((err) => {
        send(ws, { type: 'error', message: String(err.message || err) });
      });
    });

    if (ticket.mode === 'run') {
      // Course volontaire : le client peut fermer/arrêter en cours de rejeu.
      await Promise.race([
        replay(ws, page, ticket),
        new Promise((resolve) => {
          ws.once('close', resolve);
          ws.once('robotlab:stop', resolve);
        }),
      ]);
    } else {
      await new Promise((resolve) => {
        ws.once('close', resolve);
        ws.once('robotlab:stop', resolve);
      });
    }
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
