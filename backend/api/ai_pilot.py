"""Pilotage autonome d'une étape « tâche IA » (Lot 5).

Découpage : `engine/` conduit le navigateur et décrit la page ; **Django décide**
de l'action suivante. La clé API de l'utilisateur reste donc là où elle est déjà
déchiffrée (ici), et n'entre jamais dans le conteneur `engine/`.

L'IA ne fabrique jamais de sélecteur : `engine/` numérote les éléments
interactifs de la page et l'IA choisit un **index**. C'est ce qui évite le mode
d'échec bien connu du sélecteur halluciné (cf. `_valide()` de `restauration`,
qui doit revalider chaque XPath proposé par le LLM).

Le choix d'action passe par une sortie structurée JSON plutôt que par le
tool-calling natif : Claude et Mistral n'ont pas la même API d'outils, alors que
`ai_client.complete_json()` marche à l'identique sur les deux.
"""
from . import ai_client

MAX_ITERATIONS = 12

# outil → champs attendus dans `args`
TOOLS = {
    'click':    {'index'},
    'fill':     {'index', 'value'},
    'select':   {'index', 'value'},
    'press':    {'index', 'key'},
    'navigate': {'url'},
    'finish':   {'result'},
    'fail':     {'reason'},
}

SYSTEM = """\
Tu pilotes un navigateur pour accomplir un objectif précis sur une page web.

À chaque tour tu reçois : l'objectif, l'état de la page (titre, URL, texte
visible) et la liste numérotée de ses éléments interactifs. Tu choisis UNE action.

Tu ne peux agir que sur les éléments listés, en donnant leur numéro (`index`).
N'invente jamais de numéro absent de la liste, ni de sélecteur CSS.

Outils disponibles :
- `click` {index} — cliquer l'élément.
- `fill` {index, value} — saisir une valeur dans un champ.
- `select` {index, value} — choisir une option dans une liste déroulante.
- `press` {index, key} — appuyer une touche (`Enter`, `Tab`…) dans un élément.
- `navigate` {url} — aller directement à une URL.
- `finish` {result} — l'objectif est atteint. `result` décrit ce qui a été
  obtenu (et les informations extraites, s'il y en a).
- `fail` {reason} — l'objectif est impossible ici. Explique pourquoi.

Règles :
- Une seule action par tour. Après chaque action tu reverras la page mise à jour.
- Regarde l'historique : ne répète pas une action qui vient d'échouer, essaie
  autrement.
- Ne remplis jamais un champ de mot de passe : ces valeurs ne sont pas fournies.
- Appelle `finish` dès que le résultat attendu est visible — ne continue pas
  « pour vérifier ».
- Appelle `fail` plutôt que de tourner en rond si la page ne permet pas
  d'atteindre l'objectif.

Réponds avec `tool`, `args`, et `reasoning` (une phrase courte en français
expliquant ton choix — elle est affichée à l'utilisateur).
"""

ACTION_SCHEMA = {
    'type': 'object',
    'properties': {
        'tool': {'type': 'string', 'enum': sorted(TOOLS)},
        'args': {
            'type': 'object',
            'properties': {
                'index': {'type': 'integer'},
                'value': {'type': 'string'},
                'key': {'type': 'string'},
                'url': {'type': 'string'},
                'result': {'type': 'string'},
                'reason': {'type': 'string'},
            },
            'additionalProperties': False,
        },
        'reasoning': {'type': 'string'},
    },
    'required': ['tool', 'args', 'reasoning'],
    'additionalProperties': False,
}


class PilotError(Exception):
    """Action inutilisable — message destiné à l'utilisateur."""


def _render_page(page):
    """Met la page en texte pour le LLM. `page` vient de `engine/page-summary.js`."""
    lines = [
        f"Titre : {page.get('title') or '(sans titre)'}",
        f"URL : {page.get('url') or '(inconnue)'}",
    ]

    elements = page.get('elements') or []
    if elements:
        lines.append('\nÉléments interactifs :')
        for el in elements:
            label = el.get('label') or '(sans libellé)'
            detail = f" role={el.get('role')}"
            if el.get('type'):
                detail += f" type={el['type']}"
            if el.get('value'):
                detail += f" valeur actuelle=« {el['value']} »"
            lines.append(f"  [{el.get('index')}] {label}{detail}")
    else:
        lines.append('\nAucun élément interactif détecté sur cette page.')

    text = (page.get('text') or '').strip()
    if text:
        lines.append(f'\nTexte visible (extrait) :\n{text}')
    return '\n'.join(lines)


def _render_history(history):
    if not history:
        return 'Aucune action effectuée pour l’instant.'
    lines = []
    for i, entry in enumerate(history, 1):
        outcome = entry.get('outcome') or 'inconnu'
        lines.append(f"  {i}. {entry.get('summary')} → {outcome}")
    return '\n'.join(lines)


def validate_action(action, element_count):
    """Refuse tout ce qui n'est pas exécutable tel quel. Lève PilotError."""
    if not isinstance(action, dict):
        raise PilotError("Réponse de l'IA illisible.")

    tool = action.get('tool')
    if tool not in TOOLS:
        raise PilotError(f"Outil « {tool } » inconnu.")

    args = action.get('args')
    if not isinstance(args, dict):
        args = {}

    missing = TOOLS[tool] - set(args)
    if missing:
        raise PilotError(
            f"Outil « {tool} » : argument(s) manquant(s) : {', '.join(sorted(missing))}."
        )

    if 'index' in TOOLS[tool]:
        index = args.get('index')
        if not isinstance(index, int) or not (0 <= index < element_count):
            raise PilotError(
                f"L'IA a désigné l'élément {index}, hors de la liste "
                f"(0 à {element_count - 1})."
            )

    return {
        'tool': tool,
        # Seuls les arguments attendus sont transmis : rien d'autre n'atteint engine/.
        'args': {k: args[k] for k in TOOLS[tool]},
        'reasoning': (action.get('reasoning') or '').strip(),
    }


def next_action(owner_email, provider, objective, expected_result, page, history):
    """Demande au fournisseur IA la prochaine action, validée et prête à exécuter."""
    message = (
        f'Objectif : {objective}\n'
        f"Résultat attendu : {expected_result or '(non précisé)'}\n\n"
        f'Actions déjà effectuées :\n{_render_history(history)}\n\n'
        f'État de la page :\n{_render_page(page)}'
    )

    raw = ai_client.complete_json(owner_email, provider, SYSTEM, message, ACTION_SCHEMA)
    return validate_action(raw, len(page.get('elements') or []))
