from django.db import models

from .fields import EncryptedTextField

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

    `steps` est rempli à partir du Lot 2 (moteur d'enregistrement) — en Lot 1 il
    reste une liste vide, la création se limite au nom/description/URL de départ.
    """

    owner_email = models.EmailField()
    name = models.CharField(max_length=150)
    description = models.TextField(blank=True)
    start_url = models.URLField()
    steps = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'robots'
        ordering = ['-updated_at']

    def __str__(self) -> str:
        return self.name
