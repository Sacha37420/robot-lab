"""Coffre des clés IA (chantier « failles », I3) — `api/fields.py` et migration 0007.

Chiffrement sous VAULT_ENCRYPTION_KEY (et non sous SECRET_KEY), lecture de
l'ancien chiffrement, valeur historique en clair, valeur corrompue traitée comme
absente (journalisée sans sa valeur), rechiffrement par la migration, absence
de la clé dans les réponses.
"""
from cryptography.fernet import Fernet
from django.apps import apps as global_apps
from django.db import connection
from django.test import override_settings

from api import fields
from api.models import AIProviderConfig

from .outils import CasRobot

CHAMPS = __import__('api.migrations.0007_rechiffrer_coffre', fromlist=['CHAMPS']).CHAMPS


def _raw(pk):
    with connection.cursor() as cur:
        cur.execute('SELECT api_key FROM ai_provider_configs WHERE id = %s', [pk])
        return cur.fetchone()[0]


def _set_raw(pk, value):
    with connection.cursor() as cur:
        cur.execute('UPDATE ai_provider_configs SET api_key = %s WHERE id = %s', [value, pk])


def _legacy(plaintext):
    return fields._legacy_fernet().encrypt(plaintext.encode()).decode()


class _SchemaEditor:
    connection = connection


def _migrer(transform=fields.reencrypt_raw):
    return fields.rewrite_encrypted_columns(global_apps, _SchemaEditor(), CHAMPS, transform)['rewritten']


class CoffreTests(CasRobot):

    def setUp(self):
        super().setUp()
        self.cfg = AIProviderConfig.objects.create(owner_email='alice@ssolab.local', provider='claude')

    def _lire(self):
        return AIProviderConfig.objects.get(pk=self.cfg.pk).api_key

    def test_chiffre_sous_la_cle_du_coffre(self):
        self.cfg.api_key = 'sk-ant-secret-0123'
        self.cfg.save()
        raw = _raw(self.cfg.pk)
        self.assertTrue(raw.startswith('gAAAAA'))
        self.assertNotIn('sk-ant', raw)
        self.assertEqual(fields.vault_fernet().decrypt(raw.encode()).decode(), 'sk-ant-secret-0123')
        with self.assertRaises(Exception):
            fields._legacy_fernet().decrypt(raw.encode())

    def test_ancien_chiffrement_relu_puis_rechiffre(self):
        _set_raw(self.cfg.pk, _legacy('ancienne'))
        self.assertEqual(self._lire(), 'ancienne')
        self.assertEqual(_migrer(), 1)
        raw = _raw(self.cfg.pk)
        self.assertEqual(fields.vault_fernet().decrypt(raw.encode()).decode(), 'ancienne')
        self.assertEqual(_migrer(), 0)  # rejouable

    def test_clair_historique_relu_puis_rechiffre(self):
        _set_raw(self.cfg.pk, 'cle-en-clair')
        self.assertEqual(self._lire(), 'cle-en-clair')
        self.assertEqual(_migrer(), 1)
        self.assertTrue(_raw(self.cfg.pk).startswith('gAAAAA'))
        self.assertEqual(self._lire(), 'cle-en-clair')

    def test_valeur_corrompue_absente_sans_fuite_au_journal(self):
        corrompu = 'gAAAAABcorrompu-' + 'x' * 60
        _set_raw(self.cfg.pk, corrompu)
        with self.assertLogs('api.fields', level='WARNING') as logs:
            self.assertEqual(self._lire(), '')
        self.assertIn('AIProviderConfig.api_key', '\n'.join(logs.output))
        self.assertNotIn('corrompu', '\n'.join(logs.output))
        # La migration ne l'efface pas en base.
        self.assertEqual(_migrer(), 0)
        self.assertEqual(_raw(self.cfg.pk), corrompu)

    def test_jeton_d_une_autre_cle_absent(self):
        _set_raw(self.cfg.pk, Fernet(Fernet.generate_key()).encrypt(b'ailleurs').decode())
        with self.assertLogs('api.fields', level='WARNING'):
            self.assertEqual(self._lire(), '')

    def test_rotation_de_secret_key_sans_perte(self):
        self.cfg.api_key = 'survit'
        self.cfg.save()
        with override_settings(SECRET_KEY='autre-secret-key'):
            self.assertEqual(self._lire(), 'survit')

    def test_retour_arriere_de_la_migration(self):
        self.cfg.api_key = 'aller-retour'
        self.cfg.save()
        self.assertEqual(_migrer(fields.legacy_encrypt_raw), 1)
        self.assertEqual(fields._legacy_fernet().decrypt(_raw(self.cfg.pk).encode()).decode(), 'aller-retour')

    def test_cle_absente_des_reponses(self):
        r = self.alice.put('/api/ai-config/claude/', {'api_key': 'sk-ant-tres-secret'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn('sk-ant', r.content.decode())
        r = self.alice.get('/api/ai-config/claude/')
        self.assertTrue(r.json()['has_key'])
        self.assertNotIn('sk-ant', r.content.decode())

    def test_valeur_corrompue_vue_comme_pas_de_cle(self):
        _set_raw(self.cfg.pk, 'gAAAAABcorrompu-' + 'q' * 60)
        with self.assertLogs('api.fields', level='WARNING'):
            r = self.alice.get('/api/ai-config/claude/')
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()['has_key'])
