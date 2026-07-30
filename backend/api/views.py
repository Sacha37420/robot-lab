import json

from django.conf import settings
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from . import prompts
from .ai_client import AIError, AINotConfigured, complete_json
from .ai_pilot import MAX_ITERATIONS, PilotError, next_action
from .downloads import list_downloads, resolve_download
from .models import (
    PROVIDER_CHOICES, RUN_STATUS_CHOICES, AIProviderConfig, EngineTicket, Robot, RobotRun,
)
from .serializers import AIProviderConfigSerializer, RobotSerializer
from .steps import (
    StepError, invented_selectors, last_run_summary, loop_issues, restore_context,
    schema_payload, steps_for_prompt, validate_steps,
)

_VALID_PROVIDERS = {key for key, _ in PROVIDER_CHOICES}


class RobotViewSet(viewsets.ModelViewSet):
    """CRUD des robots — chacun ne voit et ne modifie que les siens."""

    serializer_class = RobotSerializer

    def get_queryset(self):
        return Robot.objects.filter(owner_email=self.request.user.email)

    def perform_create(self, serializer):
        serializer.save(owner_email=self.request.user.email)


class AIProviderConfigView(APIView):
    """
    GET/PUT /api/ai-config/<provider>/ — configuration IA de l'utilisateur courant
    pour un fournisseur donné (claude ou mistral).
    """

    def _get_or_create(self, request, provider):
        if provider not in _VALID_PROVIDERS:
            raise NotFound(f"Fournisseur inconnu : '{provider}'.")
        config, _ = AIProviderConfig.objects.get_or_create(
            owner_email=request.user.email, provider=provider,
        )
        return config

    def get(self, request, provider):
        config = self._get_or_create(request, provider)
        return Response(AIProviderConfigSerializer(config).data)

    def put(self, request, provider):
        config = self._get_or_create(request, provider)
        serializer = AIProviderConfigSerializer(config, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(AIProviderConfigSerializer(config).data)


class RecordingTicketView(APIView):
    """
    POST /api/robots/<id>/recording-ticket/ — émet un ticket à usage unique
    autorisant `engine/` à ouvrir une session sur ce robot (voir EngineTicket).
    Auth Keycloak normale, comme le reste de l'API.
    """

    def post(self, request, pk):
        robot = get_object_or_404(Robot, pk=pk)
        if robot.owner_email != request.user.email:
            raise PermissionDenied("Ce robot ne vous appartient pas.")

        # Purge légère : un ticket non consommé et périmé n'a plus d'utilité.
        EngineTicket.objects.filter(
            robot=robot, consumed_at__isnull=True,
        ).delete()

        ticket = EngineTicket.objects.create(robot=robot, owner_email=request.user.email)
        return Response({'ticket': ticket.token}, status=201)


class RunTicketView(APIView):
    """
    POST /api/robots/<id>/run-ticket/ — ouvre une exécution : crée le RobotRun
    (qui porte l'autorisation des fichiers téléchargés) et le ticket WS associé.
    """

    def post(self, request, pk):
        robot = get_object_or_404(Robot, pk=pk)
        if robot.owner_email != request.user.email:
            raise PermissionDenied("Ce robot ne vous appartient pas.")
        if not robot.steps:
            return Response(
                {'detail': "Ce robot n'a pas encore de parcours enregistré."}, status=400,
            )

        provider = (request.data.get('provider') or '').strip()
        if provider and provider not in _VALID_PROVIDERS:
            return Response({'detail': f"Fournisseur inconnu : « {provider} »."}, status=400)

        # Une étape « tâche IA » ne peut pas s'exécuter sans fournisseur : le dire
        # au lancement vaut mieux que d'échouer au milieu du parcours.
        needs_ai = any(step.get('action') == 'ai_task' for step in robot.steps)
        if needs_ai and not provider:
            return Response(
                {'detail': "Ce parcours contient une étape « tâche IA » : "
                           "choisissez le fournisseur IA qui doit la piloter."},
                status=400,
            )

        EngineTicket.objects.filter(robot=robot, consumed_at__isnull=True).delete()

        run = RobotRun.objects.create(
            robot=robot, owner_email=request.user.email, ai_provider=provider,
        )
        ticket = EngineTicket.objects.create(
            robot=robot, owner_email=request.user.email, mode='run', run=run,
        )
        return Response({'ticket': ticket.token, 'run_id': run.id}, status=201)


_RUN_STATUSES = {key for key, _ in RUN_STATUS_CHOICES}
# Nombre max de lignes de journal conservées par test — un parcours déplié
# (boucles comprises) peut compter des centaines d'étapes ; le détail complet
# n'apporte rien de plus à l'assistant qu'un résumé des échecs et un total.
MAX_RUN_LOG_LINES = 500


def _clean_run_log(raw):
    """Valide le journal envoyé par le frontend en fin d'exécution. Filtré
    silencieusement plutôt que rejeté : un client imparfait ne doit pas
    empêcher de conserver au moins le résultat global (`status`).
    """
    if not isinstance(raw, list):
        return []
    lines = []
    for entry in raw[:MAX_RUN_LOG_LINES]:
        if not isinstance(entry, dict):
            continue
        index, label, state = entry.get('index'), entry.get('label'), entry.get('state')
        if not isinstance(index, int) or not isinstance(label, str) or state not in ('done', 'failed'):
            continue
        line = {'index': index, 'label': label[:300], 'state': state}
        note = entry.get('note')
        if isinstance(note, str) and note:
            line['note'] = note[:500]
        lines.append(line)
    return lines


class RunResultView(APIView):
    """
    POST /api/robots/<id>/runs/<run_id>/result/ — consigne le résultat d'une
    exécution terminée (réussie, échouée, arrêtée par la personne, ou en erreur).

    Appelé par le frontend, jamais par `engine/` : `engine/` ne détient aucun
    droit d'écriture en base (propriété posée au Lot 2) et ne pourrait pas
    s'authentifier ici — c'est le frontend, qui porte le vrai jeton Keycloak de
    la personne, qui rapporte l'issue une fois la session WebSocket terminée.
    Sans ce point d'entrée, un test ne laissait aucune trace consultable après
    la fermeture de l'onglet, et l'assistant de modification ne pouvait jamais
    savoir si le parcours avait déjà été essayé.
    """

    def post(self, request, pk, run_id):
        robot = get_object_or_404(Robot, pk=pk)
        if robot.owner_email != request.user.email:
            raise PermissionDenied("Ce robot ne vous appartient pas.")
        run = get_object_or_404(RobotRun, pk=run_id, robot=robot)

        status = request.data.get('status')
        if status not in _RUN_STATUSES or status == 'running':
            return Response({'detail': f"Statut de résultat invalide : « {status} »."}, status=400)

        run.status = status
        run.log = _clean_run_log(request.data.get('log'))
        run.error_message = (request.data.get('message') or '').strip()[:2000]
        run.finished_at = timezone.now()
        run.save(update_fields=['status', 'log', 'error_message', 'finished_at'])
        return Response({'ok': True})


class VerifyTicketView(APIView):
    """
    POST /api/internal/verify-ticket/ — appelé par `engine/`, jamais par un
    navigateur : authentifié par secret partagé (header X-Engine-Key), même
    famille de pattern que X-Setup-Key/CatalogSyncView de lab-admin. Consomme le
    ticket (usage unique) et renvoie ce qu'il faut à `engine/` pour démarrer.

    Body : {token: str}
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        key = request.headers.get('X-Engine-Key', '')
        if not settings.ENGINE_INTERNAL_KEY or key != settings.ENGINE_INTERNAL_KEY:
            return Response({'detail': 'Clé invalide.'}, status=403)

        token = (request.data.get('token') or '').strip()
        try:
            ticket = EngineTicket.objects.select_related('robot').get(token=token)
        except EngineTicket.DoesNotExist:
            return Response({'detail': 'Ticket inconnu.'}, status=404)

        if not ticket.is_valid():
            return Response({'detail': 'Ticket expiré ou déjà utilisé.'}, status=410)

        ticket.consume()
        return Response({
            'robot_id': ticket.robot_id,
            'start_url': ticket.robot.start_url,
            'mode': ticket.mode,
            'run_id': ticket.run_id,
            # Le parcours n'est envoyé que pour une exécution : une session
            # d'enregistrement n'a aucune raison de le connaître.
            'steps': ticket.robot.steps if ticket.mode == 'run' else [],
            'variables': ticket.robot.variables if ticket.mode == 'run' else {},
            'ai_provider': ticket.run.ai_provider if ticket.run_id else '',
            'max_ai_iterations': MAX_ITERATIONS,
        })


class AIStepView(APIView):
    """
    POST /api/internal/ai-step/ — appelé par `engine/` pendant une étape
    « tâche IA » : reçoit l'état de la page, renvoie l'action suivante.

    Authentifié par secret partagé (X-Engine-Key), comme verify-ticket. C'est
    Django qui appelle le fournisseur IA : la clé de l'utilisateur, déchiffrée
    seulement ici, n'entre jamais dans le conteneur `engine/`.

    Body : {run_id, objective, expected_result, page, history}
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        key = request.headers.get('X-Engine-Key', '')
        if not settings.ENGINE_INTERNAL_KEY or key != settings.ENGINE_INTERNAL_KEY:
            return Response({'detail': 'Clé invalide.'}, status=403)

        run = get_object_or_404(RobotRun, pk=request.data.get('run_id'))
        if not run.ai_provider:
            return Response(
                {'detail': "Aucun fournisseur IA n'a été choisi pour cette exécution."},
                status=409,
            )

        objective = (request.data.get('objective') or '').strip()
        if not objective:
            return Response({'detail': 'Objectif manquant.'}, status=400)

        page = request.data.get('page')
        if not isinstance(page, dict):
            return Response({'detail': 'État de page manquant.'}, status=400)

        try:
            action = next_action(
                run.owner_email,
                run.ai_provider,
                objective,
                (request.data.get('expected_result') or '').strip(),
                page,
                request.data.get('history') or [],
            )
        except AINotConfigured as exc:
            return Response({'detail': str(exc)}, status=409)
        except (AIError, PilotError) as exc:
            return Response({'detail': str(exc)}, status=502)

        return Response(action)


class RunDownloadListView(APIView):
    """GET /api/runs/<run_id>/downloads/ — fichiers encore disponibles pour ce run."""

    def get(self, request, run_id):
        run = get_object_or_404(RobotRun, pk=run_id)
        if run.owner_email != request.user.email:
            raise PermissionDenied("Cette exécution ne vous appartient pas.")
        return Response(list_downloads(run.id))


class RunDownloadView(APIView):
    """
    GET /api/runs/<run_id>/downloads/<name>/ — sert un fichier téléchargé par le
    robot **puis le supprime du serveur**. C'est le comportement attendu : le
    serveur n'est qu'un relais, le fichier finit chez l'utilisateur et nulle part
    ailleurs.

    Le nom vient d'un site tiers via le robot : la résolution passe par
    `downloads.resolve_download()`, qui refuse tout chemin sortant du run.
    """

    def get(self, request, run_id, name):
        run = get_object_or_404(RobotRun, pk=run_id)
        if run.owner_email != request.user.email:
            raise PermissionDenied("Cette exécution ne vous appartient pas.")

        path = resolve_download(run.id, name)
        if path is None:
            raise NotFound('Fichier introuvable (ou déjà récupéré).')

        payload = path.read_bytes()
        # Suppression seulement après lecture réussie : un échec de lecture ne
        # doit pas faire disparaître le fichier sans que personne ne l'ait eu.
        path.unlink(missing_ok=True)

        response = HttpResponse(payload, content_type='application/octet-stream')
        response['Content-Disposition'] = f'attachment; filename="{path.name}"'
        response['Content-Length'] = str(len(payload))
        return response


class StepSchemaView(APIView):
    """GET /api/step-schema/ — vocabulaire d'étapes pour l'éditeur manuel.

    Sert la même source de vérité que le validateur et les prompts (`steps.py`),
    pour que le frontend n'ait pas à tenir sa propre copie de la liste des champs.
    """

    def get(self, request):
        return Response(schema_payload())


# Bornes de l'historique de conversation renvoyé par le frontend. Il est
# reconstruit à chaque appel côté client (rien n'est stocké en base), donc il
# faut le borner ici : c'est une entrée utilisateur comme une autre, et elle
# part dans un prompt facturé à la personne.
MAX_HISTORY_TURNS = 20
MAX_HISTORY_CHARS = 4000


def _clean_history(raw):
    """Valide l'historique de conversation. Silencieusement tronqué, pas rejeté :
    un historique trop long est un détail d'affichage, pas une erreur de l'usager.
    """
    if not isinstance(raw, list):
        return []
    turns = []
    for item in raw[-MAX_HISTORY_TURNS:]:
        if not isinstance(item, dict):
            continue
        role = item.get('role')
        content = item.get('content')
        if role not in ('user', 'assistant') or not isinstance(content, str):
            continue
        content = content.strip()
        if content:
            turns.append({'role': role, 'content': content[:MAX_HISTORY_CHARS]})
    return turns


# Tours d'élargissement de contexte HTML autorisés au-delà de l'appel initial
# (cf. AssistantView._build_message / `need_more_context`). Borné : chaque tour
# est un appel LLM complet, facturé à la personne — 2 suffisent largement pour
# remonter du plus étroit (l'élément) au plus large capturé (un container
# nommé ou le corps de page), au-delà duquel il n'y a de toute façon plus rien
# à montrer.
MAX_CONTEXT_ROUNDS = 2


def _has_more_context(steps, shown_levels, index):
    """L'étape `index` (1-based) a-t-elle un niveau de contexte HTML au-delà
    de celui déjà montré ? Filtre les demandes d'élargissement de l'IA portant
    sur un index hors parcours ou déjà à son niveau maximal — sans ce filtre,
    une IA qui ignore `context_available` ferait tourner la boucle jusqu'à
    `MAX_CONTEXT_ROUNDS` pour rien.
    """
    if not (1 <= index <= len(steps or [])):
        return False
    step = steps[index - 1]
    if not isinstance(step, dict):
        return False
    context = step.get('context') or []
    return shown_levels.get(index, 0) < len(context) - 1


class AssistantView(APIView):
    """
    POST /api/robots/<id>/assistant/ — demande à l'IA une modification du parcours.

    Body : {instruction: str, provider: 'claude'|'mistral', history: [...]}
    Renvoie une *proposition* ({steps, variables, explanation, warnings}) — rien
    n'est enregistré ici. L'utilisateur relit puis applique via le PATCH
    habituel : aucun contenu généré n'est appliqué sans validation humaine, et
    rien de ce que l'IA renvoie n'échappe au validateur d'étapes.
    """

    def _build_message(self, robot, instruction, shown_levels):
        # Le parcours (contexte HTML compris) est renvoyé en entier à chaque
        # tour, et fait foi : la personne peut l'avoir modifié à la main dans
        # l'éditeur entre deux messages. Ne jamais se fier à une version vue
        # plus haut dans la conversation.
        summary = last_run_summary(robot.runs.exclude(status='running').first())
        return (
            f'Robot : {robot.name}\n'
            f'Description : {robot.description or "(aucune)"}\n'
            f'URL de départ : {robot.start_url}\n\n'
            f'Parcours actuel (état réel en base, fait foi) :\n'
            f'{json.dumps(steps_for_prompt(robot.steps, shown_levels), ensure_ascii=False, indent=1)}\n\n'
            f'Variables actuelles :\n{json.dumps(robot.variables, ensure_ascii=False, indent=1)}\n\n'
            f'{summary or "Dernier test : aucune exécution conservée pour ce robot."}\n\n'
            f'Demande de la personne :\n{instruction}'
        )

    def post(self, request, pk):
        robot = get_object_or_404(Robot, pk=pk)
        if robot.owner_email != request.user.email:
            raise PermissionDenied("Ce robot ne vous appartient pas.")

        instruction = (request.data.get('instruction') or '').strip()
        provider = (request.data.get('provider') or '').strip()
        if not instruction:
            return Response({'detail': 'Instruction vide.'}, status=400)
        if provider not in _VALID_PROVIDERS:
            return Response({'detail': f"Fournisseur inconnu : « {provider} »."}, status=400)

        history = _clean_history(request.data.get('history'))
        shown_levels = {}
        message = self._build_message(robot, instruction, shown_levels)

        try:
            result = None
            for round_index in range(MAX_CONTEXT_ROUNDS + 1):
                result = complete_json(
                    request.user.email, provider, prompts.SYSTEM, message,
                    prompts.RESPONSE_SCHEMA, history=history,
                )
                requested = [
                    i for i in (result.get('need_more_context') or [])
                    if isinstance(i, int) and _has_more_context(robot.steps, shown_levels, i)
                ]
                if not requested or round_index == MAX_CONTEXT_ROUNDS:
                    break
                # Ce tour n'est qu'une étape intermédiaire, jamais montrée à la
                # personne : il entre dans l'historique pour que le tour
                # suivant garde le fil, avec un contexte élargi pour les
                # étapes demandées.
                history = history + [
                    {'role': 'user', 'content': message},
                    {'role': 'assistant', 'content': json.dumps(result, ensure_ascii=False)},
                ]
                for i in requested:
                    shown_levels[i] = shown_levels.get(i, 0) + 1
                message = self._build_message(robot, instruction, shown_levels)
        except AINotConfigured as exc:
            return Response({'detail': str(exc)}, status=409)
        except AIError as exc:
            return Response({'detail': str(exc)}, status=502)

        try:
            steps = validate_steps(result.get('steps'))
        except StepError as exc:
            return Response(
                {'detail': f'La proposition de l\'IA est invalide : {exc}'}, status=502,
            )

        # Un sélecteur inédit ne peut pas venir d'une observation : le modèle ne
        # voit jamais la page en direct (seulement le contexte HTML capturé à
        # l'enregistrement, cf. ci-dessus). La proposition entière est refusée
        # plutôt que de laisser relire un sélecteur inventé à quelqu'un qui, par
        # hypothèse, ne sait pas lire du code — la relecture humaine ne peut pas
        # jouer son rôle de garde-fou sur ce champ-là. L'assistant garde toute
        # latitude sur ce qui ne dépend pas du DOM : boucles, variables, tâches
        # IA, navigations.
        invented = invented_selectors(robot.steps, steps)
        if invented:
            details = ' ; '.join(f'étape {i} → {sel}' for i, sel in invented)
            return Response({'detail': (
                "L'assistant a inventé des sélecteurs, ce qu'il ne peut pas faire de "
                'façon fiable : il ne connaît que les éléments déjà enregistrés dans le '
                f'parcours ({details}). Reformulez la demande en vous appuyant sur les '
                'étapes existantes, ou réenregistrez le parcours pour capturer le '
                'nouvel élément.'
            )}, status=502)

        # L'IA ne reçoit et ne renvoie jamais `context` (absent de son schéma de
        # réponse) : sans ce rattachement, accepter la proposition effacerait le
        # contexte HTML capturé sur toute étape, y compris celles non touchées.
        steps = restore_context(robot.steps, steps)

        variables = result.get('variables')
        if not isinstance(variables, dict):
            variables = {}

        return Response({
            'steps': steps,
            'variables': variables,
            'explanation': (result.get('explanation') or '').strip(),
            # Signalés avant l'acceptation : une boucle proposée sans valeur ne
            # ferait rien du tout une fois enregistrée.
            'warnings': loop_issues(steps, variables),
        })
