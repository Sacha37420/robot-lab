"""Rechiffre les secrets du coffre sous VAULT_ENCRYPTION_KEY (chantier « failles », I3).

Avant : clé dérivée de SECRET_KEY. Chaque valeur lisible (ancienne clé, ou en
clair historique) est réécrite sous la clé du coffre ; une valeur déjà sous la
nouvelle clé ou indéchiffrable n'est pas touchée. Rejouable sans effet.
Retour arrière : remet les valeurs sous l'ancienne clé.
"""
from django.db import migrations

from api.fields import legacy_encrypt_raw, reencrypt_raw, rewrite_encrypted_columns

CHAMPS = [
    ('api', 'AIProviderConfig', ['api_key']),
]


def rechiffrer(apps, schema_editor):
    rewrite_encrypted_columns(apps, schema_editor, CHAMPS, reencrypt_raw)


def revenir(apps, schema_editor):
    rewrite_encrypted_columns(apps, schema_editor, CHAMPS, legacy_encrypt_raw)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0006_robotrun_test_result'),
    ]

    operations = [
        migrations.RunPython(rechiffrer, revenir),
    ]
