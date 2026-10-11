"""Tests backend de robot-lab (chantier « tests », contrat v1).

Lancer : `python manage.py test` dans /app, base PostgreSQL jetable, aucun réseau.
Tout ce qui sort du conteneur est simulé : JWKS de Keycloak (clé locale), SDK
des fournisseurs d'IA, attente entre deux tentatives. Le moteur `engine/` n'est
jamais appelé par Django : ce sont ses appels entrants qui sont joués ici.
"""
