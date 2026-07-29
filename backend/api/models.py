import secrets

from django.db import models
from django.utils import timezone

from .fields import EncryptedTextField

TICKET_TTL_SECONDS = 30

PROVIDER_CHOICES = [
    ('claude', 'Claude'),
    ('mistral', 'Mistral'),
]


class AIProviderConfig(models.Model):
    """Clé API d'un fournisseur IA, propre à un utilisateur.

    Une config par (utilisateur, fournisseur) : chacun garde sa propre clé Claude
    et/ou Mistral — pas de clé partagée pour tout le lab, pour qu'un run ne soit
    jamais facturé sur la clé d'un tiers.
    """

    owner_email = models.EmailField()
    provider = models.CharField(max_length=20, choices=PROVIDER_CHOICES)
    api_key = EncryptedTextField(blank=True)
    model_name = models.CharField(max_length=100, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'ai_provider_configs'
        unique_together = [('owner_email', 'provider')]
        ordering = ['provider']

    def __str__(self) -> str:
        return f'{self.owner_email} — {self.provider}'


class Robot(models.Model):
    """Un robot de navigation : identité + parcours enregistré.

    `steps` est une liste d'étapes structurées (`{action, selector, value, ...}`),
    capturée par le service `engine/` puis persistée par le frontend via un PATCH
    authentifié classique — `engine/` lui-même n'a aucun droit d'écriture en base.
    """

    owner_email = models.EmailField()
    name = models.CharField(max_length=150)
    description = models.TextField(blank=True)
    start_url = models.URLField()
    steps = models.JSONField(default=list, blank=True)
    # Valeurs des variables sur lesquelles les boucles itèrent
    # ({'reference': ['A1', 'B2']}), introduites par l'assistant IA du Lot 3.
    variables = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'robots'
        ordering = ['-updated_at']

    def __str__(self) -> str:
        return self.name


def _generate_token() -> str:
    return secrets.token_hex(32)


class EngineTicket(models.Model):
    """Ticket à usage unique autorisant une connexion WebSocket sur `engine/`.

    Un navigateur ne peut pas poser de header Authorization custom sur un handshake
    WS : Django reste donc le seul point qui valide le JWT Keycloak (via l'endpoint
    qui crée ce ticket), et `engine/` vérifie ce ticket par un callback interne
    (header `X-Engine-Key`, même famille que X-Setup-Key/SETUP_CATALOG_KEY de
    lab-admin) plutôt que de revalider un JWT lui-même. Consommé à la première
    vérification, expire vite (TICKET_TTL_SECONDS) : la fenêtre d'usage utile se
    limite au temps d'ouvrir la connexion WS juste après l'avoir reçu.
    """

    token = models.CharField(max_length=64, unique=True, default=_generate_token)
    robot = models.ForeignKey(Robot, on_delete=models.CASCADE, related_name='tickets')
    owner_email = models.EmailField()
    created_at = models.DateTimeField(auto_now_add=True)
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'engine_tickets'

    def is_valid(self) -> bool:
        if self.consumed_at is not None:
            return False
        age = (timezone.now() - self.created_at).total_seconds()
        return age <= TICKET_TTL_SECONDS

    def consume(self) -> None:
        self.consumed_at = timezone.now()
        self.save(update_fields=['consumed_at'])
