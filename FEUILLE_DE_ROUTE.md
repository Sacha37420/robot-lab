# Feuille de route — robot-lab

Ce fichier est lu par une machine : `validate-app.sh` refuse de déployer s'il manque ou s'il ne
contient aucun lot au format ci-dessous, et `app-test.sh` lit la commande de test. Garder les titres
tels quels.

App livrée avant l'obligation de feuille de route : le Lot 1 résume l'existant. Les lots suivants
viennent de l'analyse du 2026-10-31 ; la vue d'ensemble est dans `to_do_global.md`, à la racine du
dépôt du lab. Légende : [C] constaté, [D] déduit.

## Commande de test
python manage.py test

## Lot 1 — Existant : robots, enregistrement, assistant IA, exécution, pilotage   ·   statut : livré
**Objectif :** studio de robots de navigation web : enregistrement d'un parcours en vue live,
assistant IA, exécution avec récupération des téléchargements, pilotage autonome. Le navigateur est
isolé dans `engine/` (Node + Playwright). Accès : `developers`.
**Tâches :**
- [x] Les 5 lots d'origine (2026-07-29) ; correctifs du chantier tests (une étape mot de passe ne porte plus de valeur)
**Tests à passer avant de clore le lot :**
- [x] 93 tests backend ; `cloisonnement.spec.ts` identique au gabarit
**Vérifié le :** 2026-10-31 — relevé par lecture (version en service = `e920586`), tests non rejoués.

## Lot 2 — Engine cloisonné   ·   statut : livré
**Objectif :** le navigateur piloté ne peut joindre qu'Internet, jamais un service du lab.
**Constat [C] :** **P1, urgence U1.**
- `Robot.start_url` est un `URLField` sans filtre d'hôte (`backend/api/models.py:50`).
- L'engine fait `page.goto(ticket.start_url)` (`engine/session.js:99`) et relaie souris et clavier.
- Il est sur `dev-net` et `sso-lab_sso-net`, où il résout `code-server`, `lab-mcp` et `dev-postgres`.
- Tout membre de `developers` peut donc ouvrir `http://code-server:8091/` (sans authentification)
  dans la vue live. Cela vaut root sur l'hôte.
- L'engine reçoit aussi `env_file: .env` complet : `SECRET_KEY`, qui est aussi la clé Fernet des clés
  IA (`api/fields.py:11`), et `DB_PASSWORD`. Il ne lit que `ENGINE_INTERNAL_KEY` et les `ROBOT_*`.
**Tâches :**
- [x] `environment:` minimal pour `engine` à la place de `env_file: .env` (`ENGINE_INTERNAL_KEY`, `BACKEND_INTERNAL_URL`, `ROBOT_*` : les seuls `process.env` lus)
- [x] Validation de `start_url` côté Django : `http`/`https` seulement ; refuser un hôte sans point, une IP privée, de boucle locale ou de lien local (`api/url_policy.py`, sérialiseur ; un robot ancien à URL refusée ne reçoit plus de ticket, la base n'est pas réécrite)
- [x] Filtre de destinations dans l'engine (`page.route('**')`) : refuser tout hôte résolu en RFC1918, de boucle locale ou de lien local, ou sans point — y compris après une redirection et pendant la navigation. Deux couches, même filtre (`engine/url-guard.js`) : un proxy de sortie dans l'engine (`engine/egress-proxy.js`), par où passe tout Chromium, qui se connecte à l'adresse vérifiée ; et `context.route`. Constaté : `context.route` ne voit ni les étapes d'une redirection ni les WebSocket — le proxy, oui
- [ ] ~~Mieux encore : un réseau dédié pour l'engine~~ — écarté (chantier « urgences », contrat v1 § 7 : `validate-app.sh` n'accepte que `dev-net` et `sso-net`)
**Tests à passer avant de clore le lot :**
- [x] Test Django : `http://code-server:8091`, `http://10.0.0.1`, `http://localhost` et `http://[::1]` → 400 (`api/tests/test_start_url.py`, avec `[::ffff:127.0.0.1]`, `file:///etc/passwd`, `127.1`, CGNAT…)
- [x] Pile jetable : un `goto` vers `code-server` est bloqué, y compris derrière une redirection 302 — prouvé hors service par `engine/test/chromium.integration.test.js` (vrai Chromium, DNS simulé, aucune adresse du lab ouverte) ; à rejouer dans l'image une fois construite
- [x] `docker exec robot-lab-engine env` ne montre ni `DB_` ni `SECRET` (2026-10-31, après déploiement ; suite `engine/` rejouée dans l image : 24/24)
**Vérifié le :** 2026-10-31 — hors service, non déployé : `bash chantiers/tests/essai.sh robot-lab` → 98 tests OK (dont 5 de `test_start_url.py`) ; `npm test` dans une copie de `engine/` (dépendances du `package.json`) → 19 OK + 5 ignorés faute de navigateur ; même suite avec Playwright 1.60 et son Chromium de l'hôte (`PLAYWRIGHT_MODULE=…`) → 24/24 OK, et 4 échecs attendus quand le filtre est neutralisé (écart provoqué) ; `docker compose config` : `engine` ne reçoit plus que ses six variables. Reste après déploiement : `docker exec robot-lab-engine env` (ni `DB_` ni `SECRET`) et la suite Chromium dans l'image (Playwright 1.48). **Mis en service le 2026-10-31** (chantier « urgences ») : image construite pendant que l'ancienne tournait, `scripts/app-test.sh` vert sur cette image, puis `up -d --no-build` ; test de cloisonnement par `lab-runner` vert après déploiement.

## Lot 3 — Robustesse de l'engine   ·   statut : livré
**Objectif :** l'engine a ses propres tests, et une connexion anonyme ne le bloque pas.
**Tâches :**
- [x] Le verrou `busy` est posé avant la validation du ticket (`engine/server.js:31-37`) : le poser après (`engine/app.js`, ticket vérifié par `engine/ticket.js` avant le verrou)
- [x] Tests de `engine/` (aucun aujourd'hui) : ticket invalide, filtre de destinations, libération du verrou (`cd engine && npm test`, `node --test`)
**Tests à passer avant de clore le lot :**
- [x] Une connexion WebSocket sans ticket valide ne prend pas le verrou ; la suite `engine/` est verte
**Vérifié le :** 2026-10-31 — `npm test` (copie de `engine/`) : 4 tests du verrou verts (ticket invalide ou lent, seconde session refusée, verrou rendu après échec, client parti pendant la vérification). Non déployé. **Mis en service le 2026-10-31** (chantier « urgences ») : image construite pendant que l'ancienne tournait, `scripts/app-test.sh` vert sur cette image, puis `up -d --no-build` ; test de cloisonnement par `lab-runner` vert après déploiement.

## Lot 4 — Pilote IA éprouvé   ·   statut : à faire
**Objectif :** Ⓟ vérifier avec une vraie clé que les décisions du pilote autonome sont utilisables.
Jamais fait faute de clé.
**Tâches :**
- [ ] Trois parcours réels (formulaire, téléchargement, pagination) avec Claude, puis avec Mistral
**Tests à passer avant de clore le lot :**
- [ ] Les trois parcours aboutissent ; coût relevé
**Vérifié le :**

## Lot 5 — Gabarit front, documentation et chemin à portes   ·   statut : à faire
**Objectif :** même comportement que le gabarit corrigé (T3), un README, un déploiement par le moteur (T1).
**Tâches :**
- [ ] Polices en chemin relatif ; `tokenBases()` ; PKCE. Le `redirectUri` est déjà sur la page courante.
- [ ] `README.md` : architecture backend et engine, ce que l'engine peut joindre, clés IA
**Tests à passer avant de clore le lot :**
- [ ] `validate-app.sh robot-lab --quality-only` vert ; cloisonnement `ok` par le moteur
**Vérifié le :**
