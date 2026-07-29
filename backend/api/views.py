from rest_framework import viewsets
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PROVIDER_CHOICES, AIProviderConfig, Robot
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
