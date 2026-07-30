"""Schéma des étapes d'un robot — source de vérité partagée.

Utilisé par le validateur du serializer, par les prompts envoyés à l'IA, et
(Lot 4) par le moteur d'exécution. Toute évolution du vocabulaire d'étapes se
fait ici, pas en dupliquant la liste dans les prompts.

**Les boucles sont à plat** (`loop_start` / `loop_end`), pas imbriquées : les
sorties structurées des API LLM ne supportent pas les schémas récursifs, et une
liste plate se rejoue avec une simple pile côté moteur.
"""
import re

# `ai_task` n'a pas de champ `variable` : son texte est libre, pas une valeur
# unique. Une variable de boucle s'y insère par `{{nom}}` dans `objective`/
# `expected_result`, résolu par `engine/replay.js::expand()` avec les mêmes
# `bindings` que `fill`/`select`. Même expression ici pour que `loop_issues()`
# détecte un placeholder orphelin (aucune boucle englobante ne le lie).
VARIABLE_PLACEHOLDER = re.compile(r'\{\{\s*([a-zA-Z0-9_]+)\s*\}\}')

# Même jeu de caractères que le nom capturé par VARIABLE_PLACEHOLDER : un
# `save_as` qui ne matcherait pas ce format ne pourrait de toute façon jamais
# être relu par un `{{nom}}`.
NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_]+$')

# Étapes qui ciblent un élément précis : seules celles-là portent un `context`
# (HTML capturé autour de l'élément à l'enregistrement — cf. `CONTEXT_LEVELS`
# plus bas). Un `goto`/`scroll`/`dialog` n'a pas d'élément à situer.
CONTEXT_ACTIONS = {'click', 'fill', 'select', 'press'}

# Nombre max de niveaux de contexte HTML par étape, et taille max d'un niveau.
# Purement défensif : `engine/capture-script.js` capture déjà dans ces bornes,
# ceci protège contre une valeur fantaisiste réintroduite via un PATCH manuel.
CONTEXT_MAX_LEVELS = 4
CONTEXT_MAX_CHARS = 8000

# action → champs autorisés en plus de 'action' (tous optionnels sauf mention)
STEP_SCHEMA = {
    'goto':       {'url'},
    # `position` : point d'impact du clic dans l'élément (+ ses dimensions à
    # l'enregistrement), pour les cibles où le centre ne suffit pas — canevas,
    # carte, curseur, grande zone dont seule une partie réagit.
    # `context` : HTML autour de l'élément au moment du clic, du plus étroit
    # (l'élément lui-même) au plus large — cf. section « Contexte HTML ».
    'click':      {'selector', 'text', 'position', 'context'},
    'fill':       {'selector', 'value', 'variable', 'masked', 'context'},
    'select':     {'selector', 'value', 'variable', 'context'},
    'press':      {'selector', 'key', 'context'},
    # Position de défilement de la page — nécessaire aux pages qui chargent leur
    # contenu au fur et à mesure (liste infinie).
    'scroll':     {'x', 'y'},
    # Réponse à une boîte de dialogue du navigateur (alert/confirm/prompt).
    # Ce n'est pas une action que le robot déclenche : c'est la réponse à donner
    # quand la boîte apparaît, en conséquence d'une autre étape. Elle est
    # enregistrée telle que l'utilisateur y a répondu.
    'dialog':     {'kind', 'message', 'accept', 'value'},
    # Lot 5 — l'IA pilote elle-même cette portion de navigation.
    # `save_as` : nomme le résultat (`finish.result`) pour qu'un `ai_task` PLUS
    # LOIN dans le parcours puisse le relire via `{{ce_nom}}` — cf. section
    # « Mémoire inter-étapes ».
    'ai_task':    {'objective', 'expected_result', 'save_as'},
    'loop_start': {'variable', 'values'},
    'loop_end':   set(),
}

REQUIRED_FIELDS = {
    'goto':       {'url'},
    'click':      {'selector'},
    'fill':       {'selector'},
    'select':     {'selector'},
    'press':      {'selector', 'key'},
    'scroll':     set(),
    'dialog':     {'accept'},
    'ai_task':    {'objective'},
    'loop_start': {'variable'},
    'loop_end':   set(),
}

ACTIONS = tuple(STEP_SCHEMA)

# Comment chaque champ se saisit, et sous quel libellé. Vit ici et pas en
# TypeScript : l'éditeur manuel du frontend lit ce vocabulaire par l'API
# (`GET /api/step-schema/`) au lieu d'en tenir une copie qui dériverait au
# premier ajout d'action — même raison que pour les prompts (cf. en-tête).
FIELD_TYPES = {
    'url':             'string',
    'selector':        'string',
    'text':            'string',
    'value':           'string',
    'variable':        'string',
    'key':             'string',
    'kind':            'string',
    'message':         'string',
    'objective':       'multiline',
    'expected_result': 'multiline',
    'masked':          'boolean',
    'accept':          'boolean',
    'x':               'number',
    'y':               'number',
    'values':          'string-list',
    'position':        'position',
    'save_as':         'string',
}

FIELD_LABELS = {
    'url':             "Adresse à ouvrir",
    'selector':        "Élément ciblé (capturé à l'enregistrement)",
    'text':            'Libellé vu à l\'écran',
    'value':           'Valeur fixe',
    'variable':        'Variable (boucler dessus)',
    'key':             'Touche',
    'kind':            'Type de boîte',
    'message':         'Texte de la boîte',
    'objective':       "Objectif confié à l'IA",
    'expected_result': "À quoi on reconnaît que c'est fait",
    'masked':          'Mot de passe (valeur non enregistrée)',
    'accept':          'Accepter (OK) plutôt que refuser (Annuler)',
    'x':               'Défilement horizontal (px)',
    'y':               'Défilement vertical (px)',
    'values':          'Valeurs à parcourir',
    'position':        "Point d'impact du clic",
    'save_as':         'Mémoriser le résultat sous ce nom (réutilisable via {{nom}} plus loin)',
}

ACTION_LABELS = {
    'goto':       'Ouvrir une adresse',
    'click':      'Cliquer un élément',
    'fill':       'Remplir un champ',
    'select':     'Choisir dans une liste',
    'press':      'Appuyer sur une touche',
    'scroll':     'Faire défiler la page',
    'dialog':     'Répondre à une boîte de dialogue',
    'ai_task':    "Confier une portion à l'IA",
    'loop_start': 'Début de boucle',
    'loop_end':   'Fin de boucle',
}

# Actions que l'éditeur manuel propose d'ajouter. Les autres portent un
# `selector` capturé sur le vrai site : les créer à la main revient à inventer
# un sélecteur, exactement ce que `invented_selectors()` refuse à l'IA.
ADDABLE_ACTIONS = ('goto', 'scroll', 'ai_task', 'loop_start', 'loop_end', 'dialog')

# Champs gérés par le système, jamais par une personne : ne figurent pas dans
# le vocabulaire servi à l'éditeur manuel (`context` est capturé à
# l'enregistrement et sert de contexte à l'assistant, pas un champ à remplir).
INTERNAL_FIELDS = {'context'}


def schema_payload():
    """Vocabulaire d'étapes sous forme sérialisable, pour l'éditeur manuel."""
    return {
        'actions': [
            {
                'action': action,
                'label': ACTION_LABELS[action],
                'addable': action in ADDABLE_ACTIONS,
                'fields': [
                    {
                        'name': name,
                        'label': FIELD_LABELS[name],
                        'type': FIELD_TYPES[name],
                        'required': name in REQUIRED_FIELDS[action],
                    }
                    for name in sorted(STEP_SCHEMA[action])
                    if name not in INTERNAL_FIELDS
                ],
            }
            for action in ACTIONS
        ],
    }


class StepError(ValueError):
    """Étape refusée — message destiné à être renvoyé tel quel à l'utilisateur."""


def validate_steps(steps):
    """Valide une liste d'étapes. Lève StepError au premier problème.

    Sert autant pour les étapes capturées par `engine/` que pour celles proposées
    par l'IA : rien de ce qui n'est pas décrit ici n'entre en base.
    """
    if not isinstance(steps, list):
        raise StepError("Le parcours doit être une liste d'étapes.")

    depth = 0
    for index, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            raise StepError(f'Étape {index} : doit être un objet.')

        action = step.get('action')
        if action not in STEP_SCHEMA:
            raise StepError(
                f"Étape {index} : action « {action} » inconnue. "
                f"Actions valides : {', '.join(ACTIONS)}."
            )

        unknown = set(step) - {'action'} - STEP_SCHEMA[action]
        if unknown:
            raise StepError(
                f"Étape {index} ({action}) : champ(s) non reconnu(s) : "
                f"{', '.join(sorted(unknown))}."
            )

        missing = REQUIRED_FIELDS[action] - set(step)
        if missing:
            raise StepError(
                f"Étape {index} ({action}) : champ(s) obligatoire(s) manquant(s) : "
                f"{', '.join(sorted(missing))}."
            )

        # `position` finit passé à Playwright : sa forme est vérifiée ici, sinon
        # une valeur fantaisiste (venue de l'IA ou d'un PATCH) casserait le rejeu
        # au lieu d'être refusée à l'entrée.
        if 'position' in step:
            position = step['position']
            if not isinstance(position, dict):
                raise StepError(f'Étape {index} (click) : position doit être un objet.')
            for key in ('x', 'y'):
                if not isinstance(position.get(key), (int, float)):
                    raise StepError(
                        f'Étape {index} (click) : position.{key} doit être un nombre.'
                    )
            for key in ('w', 'h'):
                if key in position and not isinstance(position[key], (int, float)):
                    raise StepError(
                        f'Étape {index} (click) : position.{key} doit être un nombre.'
                    )

        if action == 'scroll':
            for key in ('x', 'y'):
                if key in step and not isinstance(step[key], (int, float)):
                    raise StepError(f'Étape {index} (scroll) : {key} doit être un nombre.')

        # `accept` décide d'un clic sur « OK » ou « Annuler » dans une boîte du
        # navigateur : une valeur ambiguë (chaîne « false », 0…) ne doit pas être
        # interprétée au hasard, une confirmation peut porter sur une suppression.
        if action == 'dialog' and not isinstance(step.get('accept'), bool):
            raise StepError(
                f'Étape {index} (dialog) : accept doit valoir true ou false.'
            )

        # `context` n'est jamais fourni par une personne (capturé à
        # l'enregistrement, `INTERNAL_FIELDS`) ni par l'IA (absent de son
        # schéma de réponse) — seul un PATCH manuel fabriqué à la main pourrait
        # y glisser une valeur fantaisiste. Bornée par mesure défensive.
        if 'context' in step:
            context = step['context']
            if (
                not isinstance(context, list)
                or len(context) > CONTEXT_MAX_LEVELS
                or not all(isinstance(v, str) and len(v) <= CONTEXT_MAX_CHARS for v in context)
            ):
                raise StepError(
                    f'Étape {index} ({action}) : context doit être une liste d\'au plus '
                    f'{CONTEXT_MAX_LEVELS} chaînes de {CONTEXT_MAX_CHARS} caractères chacune.'
                )

        # `save_as` finit dans un `{{nom}}` relu par une étape plus loin : mêmes
        # contraintes de forme que le nom capturé par VARIABLE_PLACEHOLDER,
        # sinon il ne pourrait jamais être référencé.
        if action == 'ai_task' and 'save_as' in step:
            save_as = step['save_as']
            if not isinstance(save_as, str) or not NAME_PATTERN.match(save_as):
                raise StepError(
                    f'Étape {index} (ai_task) : save_as doit être un nom '
                    f'(lettres, chiffres, tiret bas), sans espace ni accent.'
                )

        if action == 'loop_start':
            depth += 1
        elif action == 'loop_end':
            depth -= 1
            if depth < 0:
                raise StepError(f'Étape {index} : loop_end sans loop_start correspondant.')

    if depth > 0:
        raise StepError(f'{depth} boucle(s) ouverte(s) sans loop_end.')

    return steps


def loop_issues(steps, variables=None):
    """Ce qui rendrait une boucle inopérante — messages prêts à afficher.

    Volontairement **séparé de `validate_steps`** : ce ne sont pas des étapes
    invalides, et ça ne doit pas empêcher l'enregistrement. Une boucle sans
    valeur est l'état normal juste après une proposition de l'IA, qui ne peut pas
    inventer les valeurs à la place de la personne ; refuser le PATCH
    l'empêcherait d'atteindre l'éditeur de variables qui sert justement à les
    saisir. C'est donc un avertissement ici, et une erreur franche au rejeu
    (`expand()` dans engine/replay.js) — jamais un saut silencieux.
    """
    variables = variables or {}
    issues = []
    open_loops = []  # variables des boucles ouvertes à ce point du parcours
    # Noms mémorisés par un `ai_task.save_as` rencontré PLUS TÔT dans le
    # parcours — un `{{nom}}` peut légitimement viser l'un ou l'autre (une
    # variable de boucle ouverte, ou une mémoire déjà écrite), jamais les deux
    # en même temps (cf. contrôle de conflit plus bas).
    known_memory = set()

    for index, step in enumerate(steps, 1):
        if not isinstance(step, dict):
            continue
        action = step.get('action')

        if action == 'loop_start':
            name = step.get('variable')
            open_loops.append(name)
            if not (step.get('values') or variables.get(name)):
                issues.append(
                    f"Étape {index} : la boucle sur « {name} » n'a aucune valeur, "
                    f"elle serait entièrement sautée. Renseignez les valeurs de "
                    f"« {name} » pour qu'elle s'exécute."
                )
        elif action == 'loop_end':
            if open_loops:
                open_loops.pop()
        elif step.get('variable') and step['variable'] not in open_loops:
            # Même famille de panne silencieuse : au rejeu, l'étape ne reçoit
            # aucune valeur puisque aucune boucle ne lie cette variable.
            issues.append(
                f"Étape {index} : utilise la variable « {step['variable']} » alors "
                f"qu'aucune boucle ouverte ne lui donne de valeur."
            )
        elif action == 'ai_task':
            # Un `{{nom}}` dans le texte d'une tâche IA suit la même règle
            # qu'un `variable` orphelin : sans boucle englobante NI mémoire
            # déjà écrite sur ce nom, il reste littéral au lieu d'être résolu
            # — l'IA recevrait « {{commune}} » comme objectif au mot près.
            text = f"{step.get('objective', '')} {step.get('expected_result', '')}"
            for name in VARIABLE_PLACEHOLDER.findall(text):
                if name not in open_loops and name not in known_memory:
                    issues.append(
                        f"Étape {index} : référence « {{{{{name}}}}} » alors qu'aucune "
                        f"boucle ouverte ni mémoire d'étape précédente ne fournit cette valeur."
                    )

            save_as = step.get('save_as')
            if save_as:
                if save_as in open_loops:
                    # Même nom pour une variable de boucle et une mémoire : lequel
                    # des deux verrait `{{nom}}` résolu dépendrait de l'ordre des
                    # deux substitutions (boucle à l'aplatissement, mémoire à
                    # l'exécution) — ambigu par construction, à corriger plutôt
                    # qu'à laisser deviner.
                    issues.append(
                        f"Étape {index} : save_as « {save_as} » porte le même nom que "
                        f"la variable de boucle ouverte « {save_as} » — choisissez un "
                        f"nom différent pour éviter toute ambiguïté."
                    )
                known_memory.add(save_as)

    return issues


def invented_selectors(previous_steps, proposed_steps):
    """Sélecteurs de `proposed_steps` absents de `previous_steps` → [(index, sélecteur)].

    Un modèle de langage ne voit jamais la page : il ne peut connaître un
    sélecteur que parce qu'il figure déjà dans le parcours enregistré. Tout
    sélecteur inédit est donc une invention, quelle que soit sa plausibilité.
    Vécu en réel : `tbody > tr:nth-of-type(3) > tr:nth-of-type(3) > td... > a`,
    un `tr` enfant de `tr` — structure qu'aucun DOM ne produit, donc zéro
    correspondance et un timeout au rejeu.
    """
    known = {
        step['selector']
        for step in previous_steps or []
        if isinstance(step, dict) and step.get('selector')
    }
    return [
        (index, step['selector'])
        for index, step in enumerate(proposed_steps or [], 1)
        if isinstance(step, dict) and step.get('selector')
        and step['selector'] not in known
    ]


def steps_for_prompt(steps, shown_levels=None):
    """Parcours prêt à envoyer à l'IA, `context` réduit au niveau autorisé.

    `context[0]` (l'élément lui-même) est ce que l'IA voit par défaut — assez
    pour la plupart des demandes, sans faire payer à chaque appel le HTML
    complet de tout le parcours. `shown_levels` ({index 1-based: niveau}) fait
    monter certaines étapes vers un contexte plus large, sur demande de l'IA
    (cf. `AssistantView`, boucle `need_more_context`). L'index de contexte le
    plus large disponible est toujours signalé, pour que l'IA sache qu'il lui
    reste ou non une marge à demander.
    """
    shown_levels = shown_levels or {}
    rendered = []
    for index, step in enumerate(steps or [], 1):
        if not isinstance(step, dict):
            rendered.append(step)
            continue
        clean = {k: v for k, v in step.items() if k != 'context'}
        context = step.get('context')
        if context:
            level = min(shown_levels.get(index, 0), len(context) - 1)
            clean['context_shown'] = context[level]
            if level < len(context) - 1:
                clean['context_available'] = (
                    f"contexte plus large disponible — need_more_context: [{index}]"
                )
        rendered.append(clean)
    return rendered


def restore_context(previous_steps, steps):
    """Rattache aux étapes proposées le `context` de l'étape d'origine au même
    sélecteur (l'IA ne le reçoit jamais en entier et ne le renvoie jamais dans
    sa réponse — absent de `RESPONSE_SCHEMA`). Sans ça, toute modification
    acceptée effacerait le contexte HTML capturé à l'enregistrement, y compris
    sur les étapes que l'IA n'a pas touchées.

    Sûr par construction : `invented_selectors()` a déjà garanti que tout
    sélecteur présent dans `steps` existait déjà dans `previous_steps`.
    """
    by_selector = {}
    for step in previous_steps or []:
        if isinstance(step, dict) and step.get('selector') and step.get('context'):
            by_selector.setdefault(step['selector'], step['context'])

    for step in steps or []:
        if not isinstance(step, dict) or step.get('context'):
            continue
        context = by_selector.get(step.get('selector'))
        if context:
            step['context'] = context
    return steps


def last_run_summary(run):
    """Résumé compact du dernier test conservé, pour le contexte de l'IA.

    `None` si aucune exécution n'a encore été menée à son terme — l'IA doit
    alors dire qu'aucun test n'a été fait plutôt que d'improviser.
    """
    if run is None or run.status == 'running':
        return None

    lines = [f"Dernier test ({run.get_status_display()}, {run.created_at:%Y-%m-%d %H:%M}) :"]
    failed = [entry for entry in (run.log or []) if entry.get('state') == 'failed']
    if failed:
        for entry in failed:
            note = f" — {entry['note']}" if entry.get('note') else ''
            lines.append(f"  Étape {entry.get('index')} en échec : {entry.get('label')}{note}")
    elif run.status == 'success':
        lines.append(f"  Les {len(run.log or [])} étape(s) exécutée(s) ont réussi.")
    if run.error_message:
        lines.append(f"  Message : {run.error_message}")
    return '\n'.join(lines)
