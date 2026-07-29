// Rejeu d'un parcours enregistré. Le vocabulaire d'étapes est celui de
// backend/api/steps.py — toute évolution se fait là-bas d'abord.

const STEP_TIMEOUT_MS = 15000;
// Garde-fou : une boucle sur une longue liste ne doit pas produire un plan
// d'exécution illimité. Vécu ailleurs dans le lab (cf. MAX_PAGES de restauration).
const MAX_EXPANDED_STEPS = 2000;

/** Déplie les boucles en une liste plate d'étapes à exécuter, variables résolues. */
export function expand(steps, variables) {
  const out = [];

  const walk = (slice, bindings) => {
    for (let i = 0; i < slice.length; i++) {
      const step = slice[i];

      if (step.action === 'loop_start') {
        // Trouve le loop_end correspondant en tenant compte de l'imbrication.
        let depth = 1;
        let end = i + 1;
        for (; end < slice.length && depth > 0; end++) {
          if (slice[end].action === 'loop_start') depth++;
          else if (slice[end].action === 'loop_end') depth--;
        }
        const body = slice.slice(i + 1, end - 1);
        const values = step.values?.length ? step.values : (variables?.[step.variable] ?? []);
        for (const value of values) {
          walk(body, { ...bindings, [step.variable]: value });
          if (out.length > MAX_EXPANDED_STEPS) {
            throw new Error(
              `Parcours trop long une fois les boucles dépliées (> ${MAX_EXPANDED_STEPS} étapes).`,
            );
          }
        }
        i = end - 1;
        continue;
      }

      if (step.action === 'loop_end') continue;

      // Résout la variable ici, une bonne fois : l'exécuteur ne voit que des valeurs.
      const resolved = { ...step };
      if (step.variable && bindings[step.variable] !== undefined) {
        resolved.value = bindings[step.variable];
      }
      out.push(resolved);
    }
  };

  walk(steps, {});
  return out;
}

/** Décrit une étape en français — repris tel quel dans le journal côté frontend. */
export function describe(step) {
  switch (step.action) {
    case 'goto':    return `Ouvrir ${step.url}`;
    case 'click':   return `Cliquer ${step.text ? `« ${step.text} »` : step.selector}`;
    case 'fill':    return step.masked
      ? `Remplir ${step.selector} (mot de passe non enregistré)`
      : `Remplir ${step.selector} avec « ${step.value} »`;
    case 'select':  return `Choisir « ${step.value} » dans ${step.selector}`;
    case 'press':   return `Appuyer sur ${step.key} dans ${step.selector}`;
    case 'ai_task': return `Tâche IA : ${step.objective}`;
    default:        return step.action;
  }
}

/** Exécute une étape. Lève une erreur explicite, destinée à être affichée. */
export async function runStep(page, step) {
  const options = { timeout: STEP_TIMEOUT_MS };

  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', ...options });
      return;

    case 'click':
      await page.click(step.selector, options);
      return;

    case 'fill':
      if (step.masked) {
        // La valeur n'a volontairement jamais été enregistrée (garde-fou du Lot 2).
        throw new Error(
          `Le champ ${step.selector} est un mot de passe : sa valeur n'a pas été ` +
          `enregistrée, le robot ne peut pas la saisir.`,
        );
      }
      if (step.value === undefined) {
        throw new Error(
          `Aucune valeur pour ${step.selector}` +
          (step.variable ? ` (variable « ${step.variable} » sans valeur).` : '.'),
        );
      }
      await page.fill(step.selector, step.value, options);
      return;

    case 'select':
      await page.selectOption(step.selector, step.value, options);
      return;

    case 'press':
      await page.press(step.selector, step.key, options);
      return;

    case 'ai_task':
      // Piloté par l'IA (Lot 5). Traité en amont par session.js, qui dispose du
      // contexte du run (fournisseur, plafond d'itérations) : si on arrive ici,
      // c'est que ce contexte manque.
      throw new Error(
        "Étape « tâche IA » : aucun fournisseur IA n'est associé à cette exécution.",
      );

    default:
      throw new Error(`Action inconnue : ${step.action}`);
  }
}
