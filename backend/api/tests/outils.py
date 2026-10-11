"""Outillage commun des tests : vrais jetons RS256 signés par une clé locale.

Seul le TÉLÉCHARGEMENT du JWKS de Keycloak est remplacé. Tout le reste de
`KeycloakJWTAuthentication` (signature, expiration, azp, groupes, email)
s'exécute réellement — c'est le Verrou 2 de CLAUDE.md.
"""
import shutil
import tempfile
import time
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from api.authentication import KeycloakJWTAuthentication

CLIENT_ID = 'robot-lab'
GROUPE = 'developers'
CLE_MOTEUR = 'cle-moteur-de-test-0123456789abcdef'

CLE_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
AUTRE_CLE_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class JwksLocal:
    class _Cle:
        key = CLE_RSA.public_key()

    def get_signing_key_from_jwt(self, token):
        return self._Cle()


_ABSENT = object()


def jeton(uid='alice', groups=(GROUPE,), azp=CLIENT_ID, email=_ABSENT, duree=300, cle=CLE_RSA):
    claims = {'preferred_username': uid, 'azp': azp, 'exp': int(time.time()) + duree}
    if groups is not None:
        claims['groups'] = list(groups)
    if email is _ABSENT:
        email = f'{uid}@ssolab.local'
    if email is not None:
        claims['email'] = email
    return jwt.encode(claims, cle, algorithm='RS256')


def client(uid='alice', **kw):
    """Client portant un vrai jeton : passe par la classe d'authentification réelle."""
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f'Bearer {jeton(uid, **kw)}')
    return c


def moteur(cle=CLE_MOTEUR):
    """Client du service `engine/` : secret partagé, aucun jeton."""
    c = APIClient()
    if cle is not None:
        c.credentials(HTTP_X_ENGINE_KEY=cle)
    return c


@override_settings(
    KEYCLOAK_CLIENT_ID=CLIENT_ID,
    KEYCLOAK_REQUIRED_GROUPS=GROUPE,
    ENGINE_INTERNAL_KEY=CLE_MOTEUR,
)
class CasRobot(TestCase):
    """Base : JWKS local, dossier de téléchargements jetable, réglages figés."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(KeycloakJWTAuthentication, '_get_jwks_client',
                              classmethod(lambda cls: JwksLocal()))
        p.start()
        self.addCleanup(p.stop)

        self.downloads = tempfile.mkdtemp(prefix='robot-dl-')
        self.addCleanup(shutil.rmtree, self.downloads, True)
        s = self.settings(ROBOT_DOWNLOAD_ROOT=self.downloads)
        s.enable()
        self.addCleanup(s.disable)

        self.alice = client('alice')
        self.bob = client('bob')


PARCOURS = [
    {'action': 'goto', 'url': 'https://exemple.test/'},
    {'action': 'click', 'selector': '#entrer', 'context': ['<a id="entrer">', '<nav>…</nav>', '<body>…</body>']},
    {'action': 'fill', 'selector': '#q', 'value': 'bonjour'},
]


def creer_robot(c, **champs):
    corps = {'name': 'Robot', 'start_url': 'https://exemple.test/', 'steps': PARCOURS, **champs}
    r = c.post('/api/robots/', corps, format='json')
    assert r.status_code == 201, r.content
    return r.json()
