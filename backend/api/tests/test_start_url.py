"""Lot 2 — l'URL de départ d'un robot ne désigne jamais un service du lab."""
from api.models import Robot
from api.url_policy import raison_refus
from .outils import PARCOURS, CasRobot, creer_robot

REFUSEES = [
    'http://code-server:8091',
    'http://code-server:8091/',
    'http://code-server.:8091/',
    'http://10.0.0.1',
    'http://172.18.0.5:8000/',
    'http://192.168.1.1/',
    'http://localhost',
    'http://localhost:8000/admin/',
    'http://app.localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0x7f.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]',
    'http://[::1]:8080/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://user@10.0.0.1/',
    'file:///etc/passwd',
    'ftp://ftp.exemple.org/',
    'javascript:alert(1)',
    'chrome://settings',
]

ACCEPTEES = [
    'https://exemple.test/',
    'https://www.crunchyroll.com/',
    'http://exemple.org:8080/chemin?x=1',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
]


class PolitiqueURLTests(CasRobot):

    def test_regle_seule(self):
        for url in REFUSEES:
            with self.subTest(url=url):
                self.assertIsNotNone(raison_refus(url))
        for url in ACCEPTEES:
            with self.subTest(url=url):
                self.assertIsNone(raison_refus(url))

    def test_creation_refusee_400(self):
        for url in REFUSEES:
            with self.subTest(url=url):
                r = self.alice.post('/api/robots/', {
                    'name': 'R', 'start_url': url, 'steps': PARCOURS,
                }, format='json')
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn('start_url', r.json())
        self.assertFalse(Robot.objects.exists())

    def test_modification_refusee_400(self):
        robot = creer_robot(self.alice)
        for url in ('http://code-server:8091', 'http://10.0.0.1', 'http://localhost',
                    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd'):
            with self.subTest(url=url):
                r = self.alice.patch(f"/api/robots/{robot['id']}/", {'start_url': url},
                                     format='json')
                self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Robot.objects.get(pk=robot['id']).start_url, 'https://exemple.test/')

    def test_creation_acceptee(self):
        for url in ACCEPTEES:
            with self.subTest(url=url):
                r = self.alice.post('/api/robots/', {
                    'name': 'R', 'start_url': url, 'steps': PARCOURS,
                }, format='json')
                self.assertEqual(r.status_code, 201, r.content)

    def test_robot_ancien_avec_url_interne_ne_recoit_pas_de_ticket(self):
        # Un robot enregistré avant le filtre : la base n'est pas réécrite, mais
        # aucune session ne s'ouvre sur lui.
        robot = creer_robot(self.alice)
        Robot.objects.filter(pk=robot['id']).update(start_url='http://code-server:8091/')
        r = self.alice.post(f"/api/robots/{robot['id']}/recording-ticket/")
        self.assertEqual(r.status_code, 400)
        r = self.alice.post(f"/api/robots/{robot['id']}/run-ticket/", {}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Robot.objects.get(pk=robot['id']).tickets.exists())
        self.assertFalse(Robot.objects.get(pk=robot['id']).runs.exists())
