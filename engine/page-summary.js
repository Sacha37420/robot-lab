// Résumé de la page destiné au pilote IA (Lot 5).
//
// L'IA ne reçoit ni capture d'écran ni HTML brut : une liste **numérotée** des
// éléments interactifs, plus un extrait du texte visible. Elle agit ensuite par
// numéro, jamais par sélecteur — c'est ce qui rend l'action toujours exécutable
// et supprime le sélecteur halluciné.
//
// Chaque élément se voit poser un attribut `data-robotlab-idx` : le numéro reste
// donc valable jusqu'au prochain résumé, sans que le côté Node n'ait à conserver
// de locators (qui se périment dès que la page change).

const IDX_ATTR = 'data-robotlab-idx';
const MAX_ELEMENTS = 60;
const MAX_TEXT = 2500;

/** Sélecteur d'action pour l'élément numéroté `index`. */
export function selectorFor(index) {
  return `[${IDX_ATTR}="${index}"]`;
}

/** Annote la page et renvoie {title, url, elements, text}. */
export async function summarize(page) {
  return page.evaluate(
    ({ idxAttr, maxElements, maxText }) => {
      const SELECTOR = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]',
        '[role="tab"]', '[role="menuitem"]', '[contenteditable="true"]',
      ].join(',');

      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      // Nom accessible, dans l'ordre où un lecteur d'écran le résoudrait.
      const nameOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target?.innerText) return target.innerText.trim();
        }
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label?.innerText) return label.innerText.trim();
        }
        const wrapping = el.closest('label');
        if (wrapping?.innerText) return wrapping.innerText.trim();

        const text = (el.innerText || '').trim();
        if (text) return text;
        return (el.getAttribute('placeholder') || el.getAttribute('title')
                || el.getAttribute('name') || '').trim();
      };

      const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'select';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'submit' || type === 'button') return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        return tag;
      };

      // Nettoyage des numéros du tour précédent : sans ça, un élément disparu
      // laisserait un numéro fantôme qui pointerait sur du vide.
      for (const stale of document.querySelectorAll(`[${idxAttr}]`)) {
        stale.removeAttribute(idxAttr);
      }

      const elements = [];
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (elements.length >= maxElements) break;
        if (el.disabled || !visible(el)) continue;

        const index = elements.length;
        el.setAttribute(idxAttr, String(index));

        const type = el.getAttribute('type') || '';
        const isPassword = el.tagName.toLowerCase() === 'input' && type.toLowerCase() === 'password';
        const entry = {
          index,
          role: roleOf(el),
          label: nameOf(el).slice(0, 120),
          type,
        };
        // Jamais la valeur d'un champ mot de passe — même garde-fou qu'à
        // l'enregistrement (capture-script.js).
        if (!isPassword && 'value' in el && el.value) {
          entry.value = String(el.value).slice(0, 80);
        }
        if (el.tagName.toLowerCase() === 'select') {
          entry.options = Array.from(el.options).slice(0, 20).map(o => o.value);
        }
        elements.push(entry);
      }

      return {
        title: document.title || '',
        url: location.href,
        elements,
        text: (document.body?.innerText || '').trim().slice(0, maxText),
      };
    },
    { idxAttr: IDX_ATTR, maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
  );
}
