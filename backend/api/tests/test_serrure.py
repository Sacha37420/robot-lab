"""Verrou 2 — la serrure de l'API, avec de vrais jetons signés localement."""
import time

import jwt
from django.test import override_settings
from django.urls import get_resolver
from rest_framework.permissions import AllowAny
from rest_framework.test import APIClient

from .outils import AUTRE_CLE_RSA, CLE_RSA, CasRobot, client, jeton

ROUTE = '/api/robots/'


class SerrureTests(CasRobot):

    def test_sans_jeton_refuse(self):
        self.assertIn(APIClient().get(ROUTE).status_code, (401, 403))

    def test_en_tete_qui_n_est_pas_un_bearer_refuse(self):
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Basic {jeton()}')
        self.assertIn(c.get(ROUTE).status_code, (401, 403))

    def test_membre_du_groupe_accepte(self):
        self.assertEqual(client('alice').get(ROUTE).status_code, 200)

    def test_membre_parmi_d_autres_groupes_accepte(self):
        self.assertEqual(client('alice', groups=['famille', 'developers']).get(ROUTE).status_code, 200)

    def test_jeton_d_un_autre_client_refuse(self):
        # admin-cli : client public du realm, password grant ouvert à tout compte.
        for azp in ('admin-cli', 'storage', 'lab-admin', '', None):
            with self.subTest(azp=azp):
                r = client('alice', azp=azp).get(ROUTE)
                self.assertEqual(r.status_code, 403)
                self.assertIn('autre client', r.json()['detail'])

    def test_hors_groupe_refuse(self):
        for groups in ([], None, ['famille'], ['developer'], ['developers-bis']):
            with self.subTest(groups=groups):
                r = client('lea', groups=groups).get(ROUTE)
                self.assertEqual(r.status_code, 403)
                self.assertIn('groupe', r.json()['detail'])

    def test_jeton_expire_refuse(self):
        r = client('alice', duree=-60).get(ROUTE)
        self.assertEqual(r.status_code, 403)
        self.assertIn('Token invalide', r.json()['detail'])

    def test_jeton_signe_par_une_autre_cle_refuse(self):
        r = client('alice', cle=AUTRE_CLE_RSA).get(ROUTE)
        self.assertEqual(r.status_code, 403)
        self.assertIn('Token invalide', r.json()['detail'])

    def test_jeton_non_signe_ou_hs256_refuse(self):
        claims = {'preferred_username': 'alice', 'email': 'alice@ssolab.local', 'azp': 'robot-lab',
                  'groups': ['developers'], 'exp': int(time.time()) + 300}
        sans_signature = jwt.encode(claims, None, algorithm='none')
        hs256 = jwt.encode(claims, 'secret-partage-devine' * 3, algorithm='HS256')
        for nom, tok in (('none', sans_signature), ('hs256', hs256), ('charabia', 'pas.un.jeton')):
            with self.subTest(nom):
                c = APIClient()
                c.credentials(HTTP_AUTHORIZATION=f'Bearer {tok}')
                self.assertEqual(c.get(ROUTE).status_code, 403)

    def test_charge_utile_modifiee_apres_signature_refusee(self):
        # Jeton d'un non-membre dont on réécrit la charge utile en gardant la signature.
        hors_groupe = jeton('lea', groups=[])
        membre = jeton('lea')
        entete, _, signature = hors_groupe.split('.')
        forge = '.'.join([entete, membre.split('.')[1], signature])
        c = APIClient()
        c.credentials(HTTP_AUTHORIZATION=f'Bearer {forge}')
        self.assertEqual(c.get(ROUTE).status_code, 403)

    def test_jeton_sans_email_refuse(self):
        r = client('alice', email=None).get(ROUTE)
        self.assertEqual(r.status_code, 403)
        self.assertIn('email', r.json()['detail'])

    @override_settings(KEYCLOAK_REQUIRED_GROUPS='developers, admins')
    def test_liste_de_groupes_avec_espaces(self):
        self.assertEqual(client('a', groups=['admins']).get(ROUTE).status_code, 200)
        self.assertEqual(client('a', groups=['amis']).get(ROUTE).status_code, 403)


class InventaireTests(CasRobot):
    """Ce qui est ouvert sans jeton est une liste fermée, tirée des URL réelles."""

    def _vues(self, resolver=None):
        for p in (resolver or get_resolver()).url_patterns:
            if hasattr(p, 'url_patterns'):
                yield from self._vues(p)
            elif getattr(p.callback, 'cls', None) is not None:
                yield p.callback.cls

    def test_seules_deux_vues_echappent_au_jeton(self):
        ouvertes = {
            v.__name__ for v in self._vues()
            if AllowAny in v.permission_classes or not v.authentication_classes
        }
        self.assertEqual(ouvertes, {'VerifyTicketView', 'AIStepView'})

    def test_toute_route_refuse_un_anonyme(self):
        routes = [
            '/api/robots/', '/api/robots/1/', '/api/ai-config/claude/', '/api/ai-config/mistral/',
            '/api/step-schema/', '/api/robots/1/recording-ticket/', '/api/robots/1/run-ticket/',
            '/api/robots/1/runs/1/result/', '/api/robots/1/assistant/', '/api/runs/1/downloads/',
            '/api/runs/1/downloads/f.txt/', '/api/',
        ]
        anonyme, etranger = APIClient(), client('eve', azp='admin-cli')
        for route in routes:
            for methode in ('get', 'post', 'put', 'patch', 'delete'):
                with self.subTest(route=route, methode=methode):
                    self.assertIn(getattr(anonyme, methode)(route, {}, format='json').status_code, (401, 403))
                    self.assertEqual(getattr(etranger, methode)(route, {}, format='json').status_code, 403)
        # Garde-fou : une route ajoutée dans api/urls.py doit passer par cette liste.
        from api import urls
        self.assertEqual(len(urls.urlpatterns), 11)
        self.assertEqual(len(urls.router.registry), 1)

    def test_documentation_d_api_absente_hors_debug(self):
        for route in ('/api/schema/', '/api/docs/', '/'):
            self.assertEqual(client('alice').get(route).status_code, 404, route)

    def test_les_vues_internes_n_acceptent_pas_un_jeton_a_la_place_de_la_cle(self):
        for route in ('/api/internal/verify-ticket/', '/api/internal/ai-step/'):
            with self.subTest(route):
                self.assertEqual(self.alice.post(route, {'token': 'x'}, format='json').status_code, 403)
