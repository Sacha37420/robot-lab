"""Qui lit, modifie, lance quoi — et les clés d'API qui ne ressortent jamais."""
import os
from unittest import mock

from django.db import connection
from django.test import override_settings

from api import ai_client
from api.models import AIProviderConfig, EngineTicket, Robot, RobotRun
from .outils import CLE_MOTEUR, CasRobot, client, creer_robot, moteur

CLE_ALICE = 'sk-ant-alice-SECRET-0123456789'
CLE_BOB = 'sk-mistral-bob-SECRET-9876543210'


class CloisonnementRobotsTests(CasRobot):

    def setUp(self):
        super().setUp()
        self.robot = creer_robot(self.alice, name='Robot d\'Alice')

    def test_proprietaire_tire_du_jeton_jamais_du_corps(self):
        r = creer_robot(self.bob, owner_email='alice@ssolab.local')
        self.assertEqual(Robot.objects.get(pk=r['id']).owner_email, 'bob@ssolab.local')
        self.assertNotIn('owner_email', r)

    def test_liste_ne_montre_que_les_siens(self):
        creer_robot(self.bob, name='Robot de Bob')
        self.assertEqual([r['name'] for r in self.alice.get('/api/robots/').json()], ["Robot d'Alice"])
        self.assertEqual([r['name'] for r in self.bob.get('/api/robots/').json()], ['Robot de Bob'])

    def test_un_autre_ne_lit_ni_ne_modifie_ni_ne_supprime(self):
        url = f"/api/robots/{self.robot['id']}/"
        self.assertEqual(self.bob.get(url).status_code, 404)
        self.assertEqual(self.bob.patch(url, {'name': 'volé'}, format='json').status_code, 404)
        self.assertEqual(self.bob.put(url, {'name': 'volé', 'start_url': 'https://x.test/'}, format='json').status_code, 404)
        self.assertEqual(self.bob.delete(url).status_code, 404)
        self.assertEqual(Robot.objects.get(pk=self.robot['id']).name, "Robot d'Alice")
        # Le propriétaire, lui, fait tout.
        self.assertEqual(self.alice.patch(url, {'name': 'renommé'}, format='json').status_code, 200)
        self.assertEqual(self.alice.delete(url).status_code, 204)

    def test_actions_sur_le_robot_d_un_autre_refusees_sans_effet(self):
        pk = self.robot['id']
        run = RobotRun.objects.create(robot_id=pk, owner_email='alice@ssolab.local')
        with mock.patch('api.views.complete_json') as ia:
            for route, corps in (
                (f'/api/robots/{pk}/recording-ticket/', {}),
                (f'/api/robots/{pk}/run-ticket/', {}),
                (f'/api/robots/{pk}/runs/{run.id}/result/', {'status': 'success'}),
                (f'/api/robots/{pk}/assistant/', {'instruction': 'supprime tout', 'provider': 'claude'}),
            ):
                with self.subTest(route):
                    self.assertEqual(self.bob.post(route, corps, format='json').status_code, 403)
        ia.assert_not_called()
        self.assertEqual(EngineTicket.objects.count(), 0)
        self.assertEqual(RobotRun.objects.count(), 1)
        run.refresh_from_db()
        self.assertEqual(run.status, 'running')

    def test_resultat_refuse_pour_le_run_d_un_autre_robot(self):
        # Alice ne peut pas écrire le résultat d'un run de Bob en passant par son propre robot.
        robot_bob = creer_robot(self.bob)
        run_bob = RobotRun.objects.create(robot_id=robot_bob['id'], owner_email='bob@ssolab.local')
        r = self.alice.post(f"/api/robots/{self.robot['id']}/runs/{run_bob.id}/result/",
                            {'status': 'failed'}, format='json')
        self.assertEqual(r.status_code, 404)
        run_bob.refresh_from_db()
        self.assertEqual(run_bob.status, 'running')


class TelechargementsAutorisationTests(CasRobot):

    def setUp(self):
        super().setUp()
        robot = creer_robot(self.alice)
        self.run = RobotRun.objects.create(robot_id=robot['id'], owner_email='alice@ssolab.local')
        os.makedirs(os.path.join(self.downloads, str(self.run.id)))
        self.fichier = os.path.join(self.downloads, str(self.run.id), 'releve.pdf')
        with open(self.fichier, 'wb') as f:
            f.write(b'%PDF-confidentiel')

    def test_un_autre_ne_liste_ni_ne_recupere(self):
        base = f'/api/runs/{self.run.id}/downloads/'
        self.assertEqual(self.bob.get(base).status_code, 403)
        r = self.bob.get(base + 'releve.pdf/')
        self.assertEqual(r.status_code, 403)
        self.assertNotIn(b'confidentiel', r.content)
        # Le refus ne consomme pas le fichier : le propriétaire le récupère encore.
        self.assertTrue(os.path.exists(self.fichier))
        self.assertEqual(self.alice.get(base).json(), [{'name': 'releve.pdf', 'size': 17}])
        self.assertEqual(self.alice.get(base + 'releve.pdf/').content, b'%PDF-confidentiel')

    def test_run_inconnu(self):
        self.assertEqual(self.alice.get('/api/runs/999999/downloads/').status_code, 404)


class ConfigIATests(CasRobot):
    """La clé d'API d'un utilisateur : écrite, jamais relue, jamais celle d'un autre."""

    def test_la_cle_n_est_jamais_rendue(self):
        r = self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE, 'model_name': 'claude-x'}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['has_key'], True)
        self.assertNotIn('api_key', r.json())
        self.assertNotIn(CLE_ALICE, r.content.decode())
        r = self.alice.get('/api/ai-config/claude/')
        self.assertEqual({k: r.json()[k] for k in ('provider', 'model_name', 'has_key')},
                         {'provider': 'claude', 'model_name': 'claude-x', 'has_key': True})
        self.assertNotIn('api_key', r.json())
        self.assertNotIn(CLE_ALICE, r.content.decode())

    def test_la_cle_est_chiffree_en_base(self):
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE}, format='json')
        with connection.cursor() as cur:
            cur.execute('SELECT api_key FROM ai_provider_configs')
            (brut,), = cur.fetchall()
        self.assertTrue(brut)
        self.assertNotIn(CLE_ALICE, brut)
        self.assertNotIn('alice-SECRET', brut)
        self.assertEqual(AIProviderConfig.objects.get().api_key, CLE_ALICE)

    def test_chacun_sa_configuration(self):
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE}, format='json')
        self.assertEqual(self.bob.get('/api/ai-config/claude/').json()['has_key'], False)
        self.bob.put('/api/ai-config/claude/', {'api_key': CLE_BOB, 'model_name': 'm-bob'}, format='json')
        a = AIProviderConfig.objects.get(owner_email='alice@ssolab.local', provider='claude')
        self.assertEqual((a.api_key, a.model_name), (CLE_ALICE, ''))
        # Une clé Claude ne vaut pas pour Mistral.
        self.assertEqual(self.alice.get('/api/ai-config/mistral/').json()['has_key'], False)

    def test_changer_le_modele_ne_touche_pas_la_cle(self):
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE}, format='json')
        self.alice.put('/api/ai-config/claude/', {'model_name': 'autre'}, format='json')
        cfg = AIProviderConfig.objects.get()
        self.assertEqual((cfg.api_key, cfg.model_name), (CLE_ALICE, 'autre'))

    def test_le_fournisseur_ne_se_change_pas_par_le_corps(self):
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE, 'provider': 'mistral'}, format='json')
        self.assertEqual(AIProviderConfig.objects.get().provider, 'claude')

    def test_fournisseur_inconnu(self):
        self.assertEqual(self.alice.get('/api/ai-config/openai/').status_code, 404)
        self.assertEqual(self.alice.put('/api/ai-config/openai/', {'api_key': 'x'}, format='json').status_code, 404)
        self.assertEqual(AIProviderConfig.objects.count(), 0)

    def test_aucune_reponse_de_l_api_ne_contient_la_cle(self):
        """Balayage : toutes les lectures d'Alice, l'appel moteur, et l'IA en panne."""
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE}, format='json')
        self.alice.put('/api/ai-config/mistral/', {'api_key': CLE_BOB}, format='json')
        robot = creer_robot(self.alice, steps=[{'action': 'ai_task', 'objective': 'trouver le prix'}])
        pk = robot['id']
        ticket = self.alice.post(f'/api/robots/{pk}/run-ticket/', {'provider': 'claude'}, format='json').json()
        reponses = [
            self.alice.get('/api/robots/'), self.alice.get(f'/api/robots/{pk}/'),
            self.alice.get('/api/step-schema/'), self.alice.get('/api/ai-config/claude/'),
            self.alice.get('/api/ai-config/mistral/'), self.alice.get(f"/api/runs/{ticket['run_id']}/downloads/"),
            moteur().post('/api/internal/verify-ticket/', {'token': ticket['ticket']}, format='json'),
        ]
        vus = []

        def appel(api_key, model, system, message, schema, history):
            vus.append(api_key)
            return '{"tool": "finish", "args": {"result": "12 €"}, "reasoning": "vu"}'

        def panne(api_key, *a):
            raise RuntimeError('401 Unauthorized')

        corps = {'run_id': ticket['run_id'], 'objective': 'trouver le prix', 'page': {'elements': []}}
        with mock.patch.dict(ai_client._CALLERS, {'claude': appel}):
            reponses.append(moteur().post('/api/internal/ai-step/', corps, format='json'))
            reponses.append(self.alice.post(f'/api/robots/{pk}/assistant/',
                                            {'instruction': 'x', 'provider': 'claude'}, format='json'))
        with mock.patch.dict(ai_client._CALLERS, {'claude': panne, 'mistral': panne}):
            reponses.append(moteur().post('/api/internal/ai-step/', corps, format='json'))
            reponses.append(self.alice.post(f'/api/robots/{pk}/assistant/',
                                            {'instruction': 'x', 'provider': 'mistral'}, format='json'))
        self.assertEqual([r.status_code for r in reponses], [200] * 8 + [502, 502, 502])
        for r in reponses:
            texte = r.content.decode()
            self.assertNotIn(CLE_ALICE, texte)
            self.assertNotIn(CLE_BOB, texte)
            self.assertNotIn('SECRET', texte)
        # La clé a bien servi (sinon le balayage ne prouverait rien).
        self.assertEqual(vus, [CLE_ALICE, CLE_ALICE])


class VuesInternesTests(CasRobot):
    """Les deux seules vues sans jeton : `engine/` s'y présente avec X-Engine-Key."""

    def setUp(self):
        super().setUp()
        self.robot = creer_robot(self.alice)
        self.jeton_ticket = self.alice.post(f"/api/robots/{self.robot['id']}/recording-ticket/").json()['ticket']

    def _toutes(self, c):
        return [c.post('/api/internal/verify-ticket/', {'token': self.jeton_ticket}, format='json'),
                c.post('/api/internal/ai-step/', {'run_id': 1}, format='json')]

    def test_sans_cle_ou_mauvaise_cle_refuse_et_le_ticket_reste_valable(self):
        for nom, c in (('aucune', moteur(None)), ('fausse', moteur('x' * 35)),
                       ('prefixe', moteur(CLE_MOTEUR[:-1])), ('casse', moteur(CLE_MOTEUR.upper()))):
            with self.subTest(nom):
                for r in self._toutes(c):
                    self.assertEqual(r.status_code, 403)
        self.assertIsNone(EngineTicket.objects.get().consumed_at)
        self.assertEqual(moteur().post('/api/internal/verify-ticket/', {'token': self.jeton_ticket},
                                       format='json').status_code, 200)

    @override_settings(ENGINE_INTERNAL_KEY='')
    def test_cle_non_configuree_tout_est_ferme(self):
        # Une clé vide côté serveur ne doit pas rendre « vide == vide » acceptable.
        for c in (moteur(None), moteur('')):
            for r in self._toutes(c):
                self.assertEqual(r.status_code, 403)

    def test_cle_non_ascii_refusee_sans_erreur(self):
        # La comparaison à temps constant (hmac.compare_digest) refuse les chaînes
        # non ASCII par une exception : la vue doit répondre 403, pas 500.
        for r in self._toutes(moteur('clé-accentuée-€')):
            self.assertEqual(r.status_code, 403)
        with override_settings(ENGINE_INTERNAL_KEY='clé-du-moteur-accentuée'):
            self.assertEqual(self._toutes(moteur('cle-du-moteur-accentuee'))[0].status_code, 403)
            self.assertEqual(self._toutes(moteur('clé-du-moteur-accentuée'))[0].status_code, 200)

    def test_la_comparaison_de_la_cle_est_a_temps_constant(self):
        with mock.patch('api.views.hmac.compare_digest', wraps=__import__('hmac').compare_digest) as compare:
            for r in self._toutes(moteur('x' * 35)):
                self.assertEqual(r.status_code, 403)
        self.assertEqual(compare.call_count, 2)

    def test_lecture_refusee(self):
        for route in ('/api/internal/verify-ticket/', '/api/internal/ai-step/'):
            self.assertEqual(moteur().get(route).status_code, 405)

    def test_la_tache_ia_est_facturee_sur_la_cle_du_lanceur(self):
        """Le moteur ne choisit ni l'utilisateur ni la clé : ils viennent du run."""
        self.alice.put('/api/ai-config/claude/', {'api_key': CLE_ALICE, 'model_name': 'modele-alice'}, format='json')
        self.bob.put('/api/ai-config/claude/', {'api_key': CLE_BOB}, format='json')
        run = RobotRun.objects.create(robot_id=self.robot['id'], owner_email='alice@ssolab.local', ai_provider='claude')
        vus = []

        def appel(api_key, model, *a):
            vus.append((api_key, model))
            return '{"tool": "finish", "args": {"result": "ok"}, "reasoning": ""}'

        with mock.patch.dict(ai_client._CALLERS, {'claude': appel}):
            r = moteur().post('/api/internal/ai-step/', {
                'run_id': run.id, 'objective': 'o', 'page': {'elements': []},
                'owner_email': 'bob@ssolab.local', 'provider': 'mistral',   # ignorés
            }, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(vus, [(CLE_ALICE, 'modele-alice')])
