from django.conf import settings
from django.shortcuts import get_object_or_404
from rest_framework import viewsets
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PROVIDER_CHOICES, AIProviderConfig, EngineTicket, Robot
from .serializers import AIProviderConfigSerializer, RobotSerializer

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
        })
