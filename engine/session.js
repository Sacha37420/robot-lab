import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { runAiTask } from './ai-pilot.js';
import { captureInit } from './capture-script.js';
import { describe, expand, runStep, substitutePlaceholders } from './replay.js';

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://robot-lab-backend:8000';
const ENGINE_KEY = process.env.ENGINE_INTERNAL_KEY || '';
const DOWNLOAD_ROOT = process.env.ROBOT_DOWNLOAD_ROOT || '/downloads';
const VIEWPORT = { width: 1280, height: 800 };
// Fenêtre laissée à un téléchargement pour DÉMARRER après la dernière étape (un
// export peut être préparé côté serveur avant d'être envoyé). Réglable sans
// rebuild via le .env de l'app.
const DOWNLOAD_GRACE_MS = Number(process.env.ROBOT_DOWNLOAD_GRACE_MS || 15000);
// Plafond global de l'écriture, pour ne pas retenir le mutex de engine/ à vie.
const DOWNLOAD_CAP_MS = Number(process.env.ROBOT_DOWNLOAD_CAP_MS || 180000);
// Temps laissé à l'utilisateur pour répondre à une boîte de dialogue pendant
// l'enregistrement. La page est bloquée tant qu'elle n'est pas fermée.
const DIALOG_TIMEOUT_MS = Number(process.env.ROBOT_DIALOG_TIMEOUT_MS || 120000);

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
  let pendingDownloads = null;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    acceptDownloads: isRun,
  });
  const page = await context.newPage();

  // Les boîtes de dialogue concernent les DEUX modes : à l'enregistrement pour
  // que l'utilisateur réponde, au rejeu pour rejouer sa réponse.
  attachDialogs(context, page, ws, {
    isRun,
    steps,
    answers: isRun ? dialogAnswers(ticket.steps) : null,
  });

  if (isRun) {
    pendingDownloads = await attachDownloads(context, page, ws, ticket.run_id);
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

  return { browser, cdp, page, ticket, pendingDownloads };
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

  // Écritures en cours. `saveAs` peut durer (fichier volumineux, serveur lent) :
  // sans ce suivi, `browser.close()` coupait l'écriture en plein milieu et le
  // fichier était tronqué ou perdu — sans message d'erreur, puisque la session
  // se terminait normalement.
  const pending = new Set();

  const onDownload = (download) => {
    const task = (async () => {
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
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  page.on('download', onDownload);
  context.on('page', (opened) => opened.on('download', onDownload));
  return pending;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boîtes de dialogue du navigateur (alert / confirm / prompt / beforeunload).
 *
 * Par défaut Playwright les **rejette toutes en silence** : un site qui demande
 * confirmation avant de générer un export ne partait jamais, et la boîte n'était
 * même pas visible dans la vue live (elle est au niveau du navigateur, pas de la
 * page — le screencast ne la montre pas). Même famille de bug que l'ancien
 * filtre de clics : un abandon invisible.
 *
 * À l'enregistrement, **c'est l'utilisateur qui répond** : la question lui est
 * remontée et sa réponse est enregistrée comme étape. Au rejeu, on rejoue cette
 * réponse. Rien n'est accepté d'office — une confirmation peut porter sur une
 * suppression.
 */
function attachDialogs(context, page, ws, { isRun, steps, answers }) {
  const handler = async (dialog) => {
    const kind = dialog.type();
    const message = dialog.message();

    // « Quitter le site ? » : bloquer ici empêcherait toute navigation, et il n'y
    // a pas de décision métier derrière. On laisse passer en le signalant.
    if (kind === 'beforeunload') {
      await dialog.accept().catch(() => {});
      send(ws, { type: 'note', note: 'confirmation de quitter la page : acceptée' });
      return;
    }

    if (isRun) {
      const recorded = answers.take(message);
      if (!recorded) {
        // Boîte non enregistrée : refuser est le choix sûr (ne rien valider
        // qu'on n'a pas vu), mais il faut le dire — c'est souvent le signe d'un
        // parcours enregistré avant que le site n'ajoute cette confirmation.
        await dialog.dismiss().catch(() => {});
        send(ws, {
          type: 'note',
          note: `boîte de dialogue imprévue (« ${message} ») : refusée par précaution`,
        });
        return;
      }
      if (recorded.accept) await dialog.accept(recorded.value || '').catch(() => {});
      else await dialog.dismiss().catch(() => {});
      send(ws, {
        type: 'note',
        note: `boîte « ${message} » : ${recorded.accept ? 'acceptée' : 'refusée'} (comme à l'enregistrement)`,
      });
      return;
    }

    // ── Enregistrement : on demande à l'utilisateur ──────────────────────────
    send(ws, { type: 'dialog', kind, message, defaultValue: dialog.defaultValue() || '' });
    const answer = await waitForDialogAnswer(ws, DIALOG_TIMEOUT_MS);

    if (answer === null) {
      // Sans réponse, la page reste bloquée et la session retiendrait le mutex
      // de engine/ : on refuse et on l'annonce clairement.
      await dialog.dismiss().catch(() => {});
      send(ws, {
        type: 'error',
        message: `Aucune réponse à la boîte de dialogue après `
               + `${Math.round(DIALOG_TIMEOUT_MS / 1000)} s — refusée automatiquement.`,
      });
      return;
    }

    if (answer.accept) await dialog.accept(answer.value || '').catch(() => {});
    else await dialog.dismiss().catch(() => {});

    const step = { action: 'dialog', kind, message, accept: !!answer.accept };
    if (kind === 'prompt' && answer.accept) step.value = answer.value || '';
    steps.push(step);
    send(ws, { type: 'step', step });
  };

  page.on('dialog', handler);
  context.on('page', (opened) => opened.on('dialog', handler));
}

/** Attend la réponse du client. `null` si personne ne répond à temps. */
function waitForDialogAnswer(ws, timeoutMs) {
  return new Promise((resolve) => {
    const onAnswer = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      ws.removeListener('robotlab:dialog', onAnswer);
      resolve(null);
    }, timeoutMs);
    ws.once('robotlab:dialog', onAnswer);
  });
}

/** File des réponses enregistrées, consommée quand les boîtes réapparaissent.
 *
 * On préfère la réponse dont le message correspond exactement — l'ordre des
 * boîtes peut changer d'une exécution à l'autre. À défaut, on prend la plus
 * ancienne non consommée.
 */
function dialogAnswers(steps) {
  const queue = (steps || []).filter((s) => s.action === 'dialog');
  return {
    take(message) {
      const exact = queue.findIndex((s) => s.message === message);
      if (exact >= 0) return queue.splice(exact, 1)[0];
      return queue.shift() || null;
    },
  };
}

/** Laisse les téléchargements démarrer puis s'écrire avant de fermer la session.
 *
 * Deux attentes distinctes, et c'est important :
 *  - le **démarrage** : beaucoup de sites préparent le fichier côté serveur
 *    (génération d'un export, archive zip) et ne l'envoient que plusieurs
 *    secondes après le clic. Le délai fixe de 1,5 s d'avant coupait ces cas.
 *  - l'**écriture** : une fois démarré, `saveAs` doit aller au bout.
 *
 * On sort dès qu'il n'y a plus rien en attente, donc un parcours sans
 * téléchargement ne paie que la fenêtre de démarrage.
 */
async function settleDownloads(ws, pending, { graceMs, capMs }) {
  const startDeadline = Date.now() + graceMs;
  while (pending.size === 0 && Date.now() < startDeadline) {
    await sleep(250);
  }
  if (pending.size === 0) return;

  send(ws, { type: 'note', note: 'téléchargement en cours — attente de la fin de l\'écriture' });

  // Un téléchargement peut en déclencher un autre : on boucle jusqu'à ce que la
  // file soit vide, sous un plafond global pour ne pas retenir le mutex de
  // engine/ indéfiniment.
  const hardDeadline = Date.now() + capMs;
  while (pending.size > 0 && Date.now() < hardDeadline) {
    await Promise.all([...pending]);
    await sleep(250);
  }
  if (pending.size > 0) {
    send(ws, {
      type: 'error',
      message: `${pending.size} téléchargement(s) toujours en cours après `
             + `${Math.round(capMs / 1000)} s — fichier(s) possiblement incomplet(s).`,
    });
  }
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

/** Résout les `{{nom}}` d'un `ai_task` avec la mémoire accumulée jusqu'ici.
 *  No-op sur toute autre action — seul `ai_task` porte du texte libre où un
 *  `{{nom}}` peut apparaître (cf. steps.py). */
function resolveMemoryPlaceholders(step, memory) {
  if (step.action !== 'ai_task') return step;
  return {
    ...step,
    objective: substitutePlaceholders(step.objective || '', memory),
    expected_result: step.expected_result
      ? substitutePlaceholders(step.expected_result, memory)
      : step.expected_result,
  };
}

/** Rejoue le parcours enregistré, en signalant chaque étape au client. */
async function replay(ws, page, ticket, pendingDownloads) {
  let plan;
  try {
    plan = expand(ticket.steps || [], ticket.variables || {});
  } catch (err) {
    send(ws, { type: 'error', message: String(err.message || err) });
    return;
  }

  send(ws, { type: 'plan', total: plan.length });

  // Mémoire inter-étapes : ce qu'un `ai_task` a trouvé (`save_as`), relisible
  // par un `ai_task` plus loin via `{{nom}}`. Ne peut pas se résoudre dans
  // `expand()` (qui aplatit les boucles une bonne fois AVANT l'exécution) :
  // une valeur mémorisée n'existe qu'une fois l'étape qui l'a produite déjà
  // jouée — la substitution se fait donc ici, au fil du rejeu, en plus de
  // celle des variables de boucle faite par `expand()`.
  const memory = {};

  for (let i = 0; i < plan.length; i++) {
    // Résolu AVANT tout envoi : le journal (progression comme échec) doit
    // montrer le texte tel qu'exécuté, pas les `{{nom}}` encore littéraux —
    // sinon la personne verrait « {{maire}} » dans son propre journal alors
    // que l'IA a bien reçu la vraie valeur mémorisée.
    const step = resolveMemoryPlaceholders(plan[i], memory);
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
        if (step.save_as) memory[step.save_as] = outcome.note;
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

  // La fin n'est annoncée qu'une fois les téléchargements écrits : sinon le
  // client afficherait « terminé » avec une liste de fichiers incomplète.
  if (pendingDownloads) {
    await settleDownloads(ws, pendingDownloads,
      { graceMs: DOWNLOAD_GRACE_MS, capMs: DOWNLOAD_CAP_MS });
  }
  send(ws, { type: 'finished', total: plan.length });
}

/** Une session = un ticket = un navigateur. Ferme tout proprement dans tous les cas. */
export async function runSession(ws, token) {
  let browser = null;
  let cdp = null;
  let pendingDownloads = null;
  const steps = [];

  try {
    const setupResult = await withTimeout(setup(ws, token, steps), 20000, 'Initialisation de la session');
    browser = setupResult.browser;
    cdp = setupResult.cdp;
    pendingDownloads = setupResult.pendingDownloads;
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
        replay(ws, page, ticket, pendingDownloads),
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
    // Un arrêt manuel ou un échec peut survenir pendant l'écriture d'un
    // fichier : fermer le navigateur là tronquerait le téléchargement sans que
    // rien ne le signale. On laisse les écritures déjà démarrées se terminer
    // (sans nouvelle fenêtre d'attente au démarrage : la session est finie).
    if (pendingDownloads && pendingDownloads.size > 0) {
      await settleDownloads(ws, pendingDownloads, { graceMs: 0, capMs: DOWNLOAD_CAP_MS })
        .catch(() => {});
    }
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
    case 'dialog_answer':
      // Réveille le handler de attachDialogs, qui attend cette réponse.
      ws.emit('robotlab:dialog', { accept: !!msg.accept, value: msg.value || '' });
      return;
    case 'stop':
      send(ws, { type: 'final', steps });
      ws.emit('robotlab:stop');
      return;
    default:
      // message inconnu : ignoré, pas une erreur (protocole ouvert à extension).
  }
}
