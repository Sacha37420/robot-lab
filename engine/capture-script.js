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

  document.addEventListener('click', (event) => {
    const el = event.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"]');
    if (!el) return;
    send({ action: 'click', selector: computeSelector(el), text: textOf(el) });
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
      // qui compte est qu'elle ne contienne jamais la valeur en clair.
      if (lastReported.get(el) !== '***') {
        lastReported.set(el, '***');
        send({ action: 'fill', selector, masked: true });
      }
      return;
    }

    if (lastReported.get(el) === el.value) return; // valeur déjà signalée
    lastReported.set(el, el.value);

    if (el instanceof HTMLSelectElement) {
      send({ action: 'select', selector, value: el.value });
      return;
    }
    send({ action: 'fill', selector, value: el.value });
  };

  document.addEventListener('change', (event) => reportFieldValue(event.target), true);
  document.addEventListener('focusout', (event) => reportFieldValue(event.target), true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || el.type === 'password') return;
    send({ action: 'press', selector: computeSelector(el), key: 'Enter' });
  }, true);
}
