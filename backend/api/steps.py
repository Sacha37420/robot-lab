"""Schéma des étapes d'un robot — source de vérité partagée.

Utilisé par le validateur du serializer, par les prompts envoyés à l'IA, et
(Lot 4) par le moteur d'exécution. Toute évolution du vocabulaire d'étapes se
fait ici, pas en dupliquant la liste dans les prompts.

**Les boucles sont à plat** (`loop_start` / `loop_end`), pas imbriquées : les
sorties structurées des API LLM ne supportent pas les schémas récursifs, et une
liste plate se rejoue avec une simple pile côté moteur.
"""

# action → champs autorisés en plus de 'action' (tous optionnels sauf mention)
STEP_SCHEMA = {
    'goto':       {'url'},
    # `position` : point d'impact du clic dans l'élément (+ ses dimensions à
    # l'enregistrement), pour les cibles où le centre ne suffit pas — canevas,
    # carte, curseur, grande zone dont seule une partie réagit.
    'click':      {'selector', 'text', 'position'},
    'fill':       {'selector', 'value', 'variable', 'masked'},
    'select':     {'selector', 'value', 'variable'},
    'press':      {'selector', 'key'},
    # Position de défilement de la page — nécessaire aux pages qui chargent leur
    # contenu au fur et à mesure (liste infinie).
    'scroll':     {'x', 'y'},
    # Réponse à une boîte de dialogue du navigateur (alert/confirm/prompt).
    # Ce n'est pas une action que le robot déclenche : c'est la réponse à donner
    # quand la boîte apparaît, en conséquence d'une autre étape. Elle est
    # enregistrée telle que l'utilisateur y a répondu.
    'dialog':     {'kind', 'message', 'accept', 'value'},
    # Lot 5 — l'IA pilote elle-même cette portion de navigation.
    'ai_task':    {'objective', 'expected_result'},
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
