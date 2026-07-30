// Rejeu d'un parcours enregistré. Le vocabulaire d'étapes est celui de
// backend/api/steps.py — toute évolution se fait là-bas d'abord.

const STEP_TIMEOUT_MS = 15000;
// `reveal()` n'est qu'un coup de pouce optimiste : le vrai contrôle
// d'actionnabilité est fait par l'action elle-même. Lui laisser le timeout
// complet ferait perdre 15 s par élément non défilable AVANT même d'essayer
// d'agir — mesuré : 30 s pour une seule étape sur un élément masqué.
const REVEAL_TIMEOUT_MS = 2000;
// Première tentative stricte avant de forcer une liste déroulante : assez pour
// un élément lent à apparaître, assez court pour ne pas doubler l'attente quand
// il est masqué en permanence (forcer donne de toute façon le bon résultat).
const SELECT_STRICT_TIMEOUT_MS = 5000;
// Garde-fou : une boucle sur une longue liste ne doit pas produire un plan
// d'exécution illimité. Vécu ailleurs dans le lab (cf. MAX_PAGES de restauration).
const MAX_EXPANDED_STEPS = 2000;

const VARIABLE_PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Remplace `{{nom}}` par la valeur liée dans `bindings`, s'il y en a une.
 *  Un placeholder sans boucle englobante correspondante est laissé tel quel —
 *  visible dans le journal d'exécution, ce qui vaut mieux qu'une disparition
 *  silencieuse (même choix que pour un `variable` orphelin sur `fill`/`select`,
 *  cf. `loop_issues()` côté backend, qui détecte ce même cas ici).
 */
export function substitutePlaceholders(text, bindings) {
  return text.replace(VARIABLE_PLACEHOLDER, (match, name) => (
    bindings[name] !== undefined ? bindings[name] : match
  ));
}

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
        // Une boucle sans valeur ne doit JAMAIS être sautée en silence : le robot
        // se terminait en succès après avoir ignoré tout le corps de boucle, sans
        // rien signaler (vécu en réel — 9 étapes exécutées sur 15, run « réussi »).
        // On échoue franchement, avec le nom de la variable à renseigner.
        if (!values.length) {
          throw new Error(
            `La boucle sur « ${step.variable} » n'a aucune valeur : rien à répéter. `
            + `Renseignez les valeurs de « ${step.variable} » avant de lancer le robot.`,
          );
        }
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
      // `ai_task` n'a pas de champ `variable` (son texte est libre, pas une
      // valeur unique) : une variable de boucle s'y insère par `{{nom}}` dans
      // `objective`/`expected_result`, résolu ici avec les mêmes `bindings`
      // que `fill`/`select` — sans ça, une boucle autour d'un `ai_task` ne
      // pouvait faire varier ni son objectif ni son critère de réussite d'un
      // tour à l'autre.
      if (step.action === 'ai_task') {
        if (resolved.objective) resolved.objective = substitutePlaceholders(resolved.objective, bindings);
        if (resolved.expected_result) {
          resolved.expected_result = substitutePlaceholders(resolved.expected_result, bindings);
        }
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
    case 'scroll':  return `Faire défiler jusqu'à ${Math.round(step.y || 0)} px`;
    case 'dialog':  return `Boîte « ${step.message || '' } » : ${step.accept ? 'Accepter' : 'Refuser'}`;
    case 'ai_task': return `Tâche IA : ${step.objective}`;
    default:        return step.action;
  }
}

/** Amène l'élément dans la vue avant d'agir.
 *
 * Playwright fait déjà défiler tout seul dans ses contrôles d'actionnabilité ;
 * l'appel explicite sert à deux choses : échouer avec un message clair quand
 * l'élément reste inatteignable (plutôt qu'un timeout d'action opaque), et
 * déclencher les pages qui n'affichent leur contenu qu'une fois défilé.
 */
async function reveal(locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: REVEAL_TIMEOUT_MS });
  } catch {
    // Pas bloquant : l'action qui suit refera ses propres contrôles et
    // produira, elle, un message d'erreur exploitable.
  }
}

// Balises où le point d'impact porte le sens de l'action : cliquer au centre
// d'une carte ou d'un canevas ne veut pas dire la même chose que cliquer au bord.
const POSITIONAL_TAGS = new Set(['canvas', 'svg', 'img', 'map', 'area', 'video']);

/** Décide s'il faut rejouer le point d'impact exact, et le replace dans
 *  l'élément tel qu'il est maintenant.
 *
 * **C'est le sélecteur qui identifie l'élément, jamais la position** — elle n'est
 * qu'un décalage à l'intérieur de la cible déjà trouvée. On ne l'applique donc que
 * là où elle change le sens du clic :
 *   - balise à surface signifiante (canevas, carte, image cliquable…) ;
 *   - clic délibérément excentré sur un grand élément (curseur, barre de
 *     progression, zone dont seule une partie réagit).
 * Pour un bouton ou un lien ordinaire, le centre est plus robuste : une position
 * héritée d'une mise en page légèrement différente pourrait tomber sur un enfant
 * qui recouvre la cible.
 *
 * Si l'élément n'a plus la même taille, la position est reportée
 * proportionnellement puis bornée à l'intérieur (Playwright refuse un point hors
 * de l'élément).
 */
function scaledPosition(step, box, tagName) {
  const p = step.position;
  if (!p || !box || !box.width || !box.height) return undefined;

  const positional = POSITIONAL_TAGS.has((tagName || '').toLowerCase());
  if (!positional) {
    // À quelle distance du centre le clic a-t-il été fait, en proportion ?
    const offCentreX = p.w ? Math.abs(p.x - p.w / 2) / p.w : 0;
    const offCentreY = p.h ? Math.abs(p.y - p.h / 2) / p.h : 0;
    const deliberatelyOffCentre = offCentreX > 0.25 || offCentreY > 0.25;
    const large = box.width > 150 || box.height > 150;
    if (!(deliberatelyOffCentre && large)) return undefined;   // clic au centre
  }

  let { x, y } = p;
  if (p.w && p.h && (Math.abs(p.w - box.width) > 1 || Math.abs(p.h - box.height) > 1)) {
    x = (x / p.w) * box.width;
    y = (y / p.h) * box.height;
  }
  return {
    x: Math.min(Math.max(x, 1), box.width - 1),
    y: Math.min(Math.max(y, 1), box.height - 1),
  };
}

/** Valeur actuelle d'un champ, quel que soit son type. */
async function readValue(locator) {
  return locator.evaluate((el) => {
    if (el.isContentEditable) return el.innerText;
    return 'value' in el ? String(el.value) : '';
  });
}

/** Exécute une étape. Lève une erreur explicite, destinée à être affichée.
 *  Peut renvoyer une note (string) à afficher dans le journal quand le rejeu a
 *  dû s'écarter du chemin nominal — ne jamais le faire en silence. */
export async function runStep(page, step) {
  const options = { timeout: STEP_TIMEOUT_MS };

  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', ...options });
      return;

    case 'scroll':
      await page.evaluate(
        ({ x, y }) => window.scrollTo(x, y),
        { x: step.x || 0, y: step.y || 0 },
      );
      // Laisse le temps au contenu déclenché par le défilement d'arriver.
      await page.waitForTimeout(500);
      return;

    case 'dialog':
      // Rien à exécuter : une boîte de dialogue n'est pas déclenchée par le robot
      // mais par le site, en conséquence d'une autre étape. La réponse est
      // appliquée par le handler de session.js au moment où la boîte apparaît.
      // L'étape reste dans le parcours pour rester visible et modifiable.
      return;

    case 'click': {
      // Le sélecteur, et lui seul, désigne quoi cliquer.
      const locator = page.locator(step.selector).first();
      await reveal(locator);
      const [box, tagName] = await Promise.all([
        locator.boundingBox().catch(() => null),
        locator.evaluate((el) => el.tagName).catch(() => ''),
      ]);
      const position = scaledPosition(step, box, tagName);
      await locator.click(position ? { ...options, position } : options);
      return;
    }

    case 'fill': {
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

      const locator = page.locator(step.selector).first();
      await reveal(locator);
      await locator.fill(step.value, options);

      // `fill` écrit la valeur et n'émet qu'un seul évènement `input`. Ça suffit
      // à un champ ordinaire, mais pas à une autocomplétion ou à un masque de
      // saisie qui écoutent chaque frappe : le champ peut rester vide, tronqué
      // ou reformaté. On relit donc ce qui a réellement atterri.
      if ((await readValue(locator)) === step.value) return;

      await locator.click(options);
      await locator.press('ControlOrMeta+a', options);
      await locator.pressSequentially(step.value, { ...options, delay: 30 });

      const got = await readValue(locator);
      if (got === step.value) {
        return `saisie frappe par frappe (le remplissage direct n'avait pas pris)`;
      }
      // Un champ masqué/normalisé peut légitimement différer (téléphone, date) :
      // on le signale sans faire échouer le parcours.
      return `valeur après saisie : « ${got} » (demandée : « ${step.value} »)`;
    }

    case 'select': {
      const locator = page.locator(step.selector).first();
      await reveal(locator);
      try {
        await locator.selectOption(step.value, { ...options, timeout: SELECT_STRICT_TIMEOUT_MS });
      } catch (err) {
        // Un <select> natif masqué derrière un widget maison n'est jamais
        // « visible » au sens de Playwright. On réessaie en forçant plutôt que
        // d'échouer — mais on le dit, pour ne pas masquer un vrai problème.
        if (!/not visible|not enabled|not stable/i.test(String(err.message))) throw err;
        await locator.selectOption(step.value, { ...options, force: true });
        return 'liste masquée à l\'écran : choix appliqué directement';
      }
      return;
    }

    case 'press': {
      const locator = page.locator(step.selector).first();
      await reveal(locator);
      await locator.press(step.key, options);
      return;
    }

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
