// Boucle de pilotage d'une étape « tâche IA » (Lot 5).
//
// engine/ conduit le navigateur ; Django décide. À chaque tour : résumer la page
// → demander l'action à Django (qui appelle le fournisseur IA avec la clé de
// l'utilisateur) → exécuter → recommencer, jusqu'à `finish`, `fail`, ou le
// plafond d'itérations.

import { selectorFor, summarize } from './page-summary.js';

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://robot-lab-backend:8000';
const ENGINE_KEY = process.env.ENGINE_INTERNAL_KEY || '';
const ACTION_TIMEOUT_MS = 15000;
// Un appel LLM est lent (secondes), mais pas illimité : sans plafond une session
// bloquée retiendrait le mutex de engine/ indéfiniment.
const DECISION_TIMEOUT_MS = 120000;

async function askBackend(payload) {
  const res = await fetch(`${BACKEND_URL}/api/internal/ai-step/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Engine-Key': ENGINE_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Décision IA refusée (${res.status})`);
  }
  return res.json();
}

/** Exécute l'action choisie. Renvoie un compte rendu court pour l'historique. */
async function applyAction(page, action) {
  const { tool, args } = action;
  const options = { timeout: ACTION_TIMEOUT_MS };

  switch (tool) {
    case 'click':
      await page.click(selectorFor(args.index), options);
      return 'clic effectué';
    case 'fill':
      await page.fill(selectorFor(args.index), args.value, options);
      return 'champ rempli';
    case 'select':
      await page.selectOption(selectorFor(args.index), args.value, options);
      return 'option choisie';
    case 'press':
      await page.press(selectorFor(args.index), args.key, options);
      return `touche ${args.key} envoyée`;
    case 'navigate':
      await page.goto(args.url, { waitUntil: 'domcontentloaded', ...options });
      return 'navigation effectuée';
    default:
      throw new Error(`Outil non exécutable : ${tool}`);
  }
}

/** Décrit une action en français — repris tel quel dans le journal du frontend. */
function describeAction(action, page) {
  const { tool, args } = action;
  const label = (i) => {
    const el = (page.elements || []).find(e => e.index === i);
    return el?.label ? `« ${el.label} »` : `élément ${i}`;
  };
  switch (tool) {
    case 'click':    return `Cliquer ${label(args.index)}`;
    case 'fill':     return `Remplir ${label(args.index)} avec « ${args.value} »`;
    case 'select':    return `Choisir « ${args.value} » dans ${label(args.index)}`;
    case 'press':    return `Appuyer sur ${args.key} dans ${label(args.index)}`;
    case 'navigate': return `Aller à ${args.url}`;
    case 'finish':   return `Objectif atteint : ${args.result}`;
    case 'fail':     return `Abandon : ${args.reason}`;
    default:         return tool;
  }
}

/**
 * Pilote une étape `ai_task`. `report(payload)` remonte chaque tour au client.
 * Résout `{ok, note}` — ne lève que sur erreur d'infrastructure.
 */
export async function runAiTask(page, step, { runId, maxIterations, report }) {
  const history = [];
  const cap = maxIterations || 12;

  for (let turn = 1; turn <= cap; turn++) {
    const summary = await summarize(page);

    let action;
    try {
      action = await askBackend({
        run_id: runId,
        objective: step.objective,
        expected_result: step.expected_result || '',
        page: summary,
        history,
      });
    } catch (err) {
      return { ok: false, note: `Décision IA impossible : ${err.message || err}` };
    }

    const label = describeAction(action, summary);
    report({ type: 'ai_action', turn, total: cap, label, reasoning: action.reasoning });

    if (action.tool === 'finish') {
      return { ok: true, note: action.args.result };
    }
    if (action.tool === 'fail') {
      return { ok: false, note: action.args.reason };
    }

    let outcome;
    try {
      outcome = await applyAction(page, action);
    } catch (err) {
      // L'échec n'arrête pas la tâche : il entre dans l'historique pour que l'IA
      // tente autrement au tour suivant. C'est le cœur de l'intérêt du mode IA
      // sur une page qui change — s'arrêter au premier raté le viderait de sens.
      outcome = `échec (${String(err.message || err).split('\n')[0]})`;
    }
    history.push({ summary: label, outcome });

    // Laisse la page réagir (navigation, requête XHR, rendu).
    await page.waitForTimeout(800);
  }

  return {
    ok: false,
    note: `Objectif non atteint après ${cap} tours (plafond de sécurité).`,
  };
}
