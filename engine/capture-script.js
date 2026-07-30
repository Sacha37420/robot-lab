// Exécuté DANS la page (via page.addInitScript) — pas de fermeture sur le
// contexte Node, uniquement des API navigateur standard.
export function captureInit() {
  function computeSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

    // Repli : chemin tag(+nth-of-type) sur quelques ancêtres — une heuristique
    // suffisante pour ce lot, réparable plus tard par l'assistant IA si le
    // sélecteur casse (même esprit que la revalidation côté restauration).
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1 && node !== document.body; i++) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    return (el.innerText || el.value || '').trim().slice(0, 80);
  }

  const send = (payload) => {
    if (window.__robotLabRecord__) window.__robotLabRecord__(payload);
  };

  // Contexte HTML autour d'une interaction — donné à l'assistant de
  // modification pour qu'il puisse juger d'un sélecteur ou d'une demande sans
  // avoir jamais vu la page (cf. backend/api/prompts.py). Conteneurs au-delà
  // desquels la sérialisation grossit vite sans apporter d'information
  // supplémentaire pour un modèle de langage — souvent le corps entier de la page.
  const LANDMARK = 'form, section, article, table, fieldset, nav, header, main, '
    + '[role="dialog"], [role="region"], [role="tabpanel"]';

  function sanitizeClone(el) {
    // Clone plutôt que sérialiser en direct : permet de retirer proprement
    // scripts et gestionnaires inline sans jamais toucher la vraie page.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script, style').forEach((n) => n.remove());
    // `[clone, ...]` et non `clone.querySelectorAll('*')` seul : `querySelectorAll`
    // ne renvoie que les DESCENDANTS, jamais le nœud racine — et la racine est
    // justement le cas le plus fréquent (le niveau 0 EST l'élément cliqué :
    // un `onclick` dessus serait resté tel quel sans ce nœud en plus).
    [clone, ...clone.querySelectorAll('*')].forEach((node) => {
      // Défense en profondeur : `.outerHTML` ne reflète de toute façon jamais
      // ce que la personne a tapé dans un champ (seul l'attribut HTML
      // d'origine y figure), mais un mot de passe ne doit jamais apparaître
      // même vide.
      if (node instanceof HTMLInputElement && node.type === 'password') {
        node.removeAttribute('value');
      }
      for (const attr of [...node.attributes]) {
        if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
      }
    });
    return clone.outerHTML;
  }

  function truncate(html, max) {
    return html.length > max ? html.slice(0, max) + ' …(tronqué)' : html;
  }

  /** Contexte HTML autour d'un élément, du plus étroit (l'élément lui-même) au
   *  plus large (son container nommé) — jamais plus de 3 niveaux, pour ne pas
   *  faire payer à chaque appel de l'assistant le HTML complet de la page.
   *  L'assistant ne voit d'abord que le niveau 0 ; il peut demander la suite
   *  (`need_more_context`) si ça ne suffit pas à juger. */
  function captureContext(el) {
    const chain = [el];
    if (el.parentElement && el.parentElement !== document.body) {
      chain.push(el.parentElement);
    }
    let landmark = el.closest(LANDMARK);
    if (landmark === el) landmark = el.parentElement?.closest(LANDMARK) ?? null;
    if (landmark && landmark !== document.body && !chain.includes(landmark)) {
      chain.push(landmark);
    }
    const caps = [500, 2000, 6000];
    return chain.map((node, i) => truncate(sanitizeClone(node), caps[i] ?? 6000));
  }

  // Éléments qui font office de contrôle : quand le clic tombe à l'intérieur de
  // l'un d'eux (sur le <span> d'un bouton, par ex.), c'est LUI qu'on veut viser,
  // pas le nœud exact touché — son sélecteur est plus stable.
  const CONTROL = [
    'a[href]', 'button', 'input[type="submit"]', 'input[type="button"]',
    'summary', 'label', 'option',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    'li', '[onclick]', '[tabindex]',
  ].join(',');

  // TOUS les clics délibérés sont enregistrés, pas seulement ceux qui atterrissent
  // sur un <button>/<a>. La version précédente filtrait sur une courte liste et
  // abandonnait le reste en silence : un onglet, un accordéon ou un sélecteur
  // maison en <div> n'était jamais capturé, et le rejeu échouait plus loin sur un
  // élément resté caché — sans que rien n'indique l'étape manquante.
  document.addEventListener('click', (event) => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    // Un clic dans le vide (fond de page) ne décrit aucune intention reproductible.
    if (node === document.body || node === document.documentElement) return;

    const target = node.closest(CONTROL) || node;
    const rect = target.getBoundingClientRect();

    const step = {
      action: 'click', selector: computeSelector(target), text: textOf(target),
      context: captureContext(target),
    };

    // Point d'impact DANS l'élément, plus ses dimensions au moment du clic. Le
    // centre ne suffit pas partout : canevas, carte, curseur, barre de
    // progression, grande zone cliquable dont seule une partie réagit. Les
    // dimensions permettent de replacer le point si l'élément n'a pas la même
    // taille au rejeu.
    if (rect.width > 0 && rect.height > 0) {
      step.position = {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }
    send(step);
  }, true);

  // Défilement : utile pour les pages qui chargent au fur et à mesure (liste
  // infinie) — sans ce geste rejoué, le contenu attendu plus bas n'existe jamais.
  // Playwright fait défiler tout seul pour atteindre un élément DÉJÀ présent ;
  // ce qu'il ne peut pas deviner, c'est qu'il faut défiler pour le faire exister.
  let scrollTimer = null;
  let lastScroll = { x: 0, y: 0 };
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    // Anti-rafale : un geste de molette émet des dizaines d'évènements, on ne
    // garde que la position d'arrivée.
    scrollTimer = setTimeout(() => {
      const x = Math.round(window.scrollX);
      const y = Math.round(window.scrollY);
      if (Math.abs(x - lastScroll.x) < 80 && Math.abs(y - lastScroll.y) < 80) return;
      lastScroll = { x, y };
      send({ action: 'scroll', x, y });
    }, 400);
  }, true);

  // 'change' ne se déclenche qu'au blur — le tout dernier champ rempli avant
  // un clic sur "Envoyer" (qui ne rend pas toujours la main au champ avant
  // l'action suivante) peut ne jamais blurrer. 'focusout' couvre ce trou (il
  // se déclenche aussi au blur, mais de façon plus systématique lors d'un clic
  // ailleurs) ; la Map déduplique pour ne jamais émettre deux fois la même
  // valeur "posée" pour un champ.
  const lastReported = new WeakMap();

  const reportFieldValue = (el) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;

    const selector = computeSelector(el);
    if (el instanceof HTMLInputElement && el.type === 'password') {
      // Garde-fou vie privée : jamais la valeur d'un champ mot de passe. Pas
      // de déduplication ici : peu importe si l'étape masquée se répète, ce
      // qui compte est qu'elle ne contienne jamais la valeur en clair. Le
      // contexte reste capturé (l'élément lui-même est déjà purgé de sa
      // valeur par `sanitizeClone`) : il aide l'assistant à situer le champ.
      if (lastReported.get(el) !== '***') {
        lastReported.set(el, '***');
        send({ action: 'fill', selector, masked: true, context: captureContext(el) });
      }
      return;
    }

    if (lastReported.get(el) === el.value) return; // valeur déjà signalée
    lastReported.set(el, el.value);

    if (el instanceof HTMLSelectElement) {
      send({ action: 'select', selector, value: el.value, context: captureContext(el) });
      return;
    }
    send({ action: 'fill', selector, value: el.value, context: captureContext(el) });
  };

  document.addEventListener('change', (event) => reportFieldValue(event.target), true);
  document.addEventListener('focusout', (event) => reportFieldValue(event.target), true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || el.type === 'password') return;
    send({ action: 'press', selector: computeSelector(el), key: 'Enter', context: captureContext(el) });
  }, true);
}
