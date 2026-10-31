"""Adresses que le navigateur piloté a le droit d'ouvrir (Lot 2, contrat « urgences » § 7).

`engine/` est sur `dev-net` et `sso-net` : sans filtre, une URL de départ
`http://code-server:8091/` ou `http://dev-postgres:5432/` ouvrait un service du
lab dans la vue live. La règle : le robot ne joint qu'Internet.

Ce module ne fait **aucune résolution DNS** : il refuse ce qui se voit dans
l'URL (schéma, nom sans point, `localhost`, adresse IP littérale non publique).
Le filtre qui résout le nom, y compris pour les redirections, les
sous-ressources et les WebSocket, est dans `engine/url-guard.js` — c'est lui la
barrière ; celui-ci donne une erreur lisible à l'enregistrement.

Même règle des deux côtés : garder `engine/url-guard.js` aligné.
"""
import ipaddress
import re
from urllib.parse import urlsplit

SCHEMAS_AUTORISES = {'http', 'https'}

# Plages IPv6 qui portent une IPv4 ou qui ne sont pas routées sur Internet, et
# que `ipaddress` ne refuse pas toutes d'elle-même.
_V6_REFUSES = [ipaddress.ip_network(n) for n in (
    '::/96',            # IPv4 « compatible » (obsolète)
    '::ffff:0:0/96',    # IPv4 mappée — traitée aussi par ipv4_mapped
    '64:ff9b::/96',     # NAT64 : porte une IPv4 arbitraire
    '64:ff9b:1::/48',
    '100::/64',         # discard
    '2001::/23',        # IETF (dont Teredo 2001::/32)
    '2001:db8::/32',    # documentation
    '2002::/16',        # 6to4 : porte une IPv4 arbitraire
    'fc00::/7',         # ULA
    'fe80::/10',        # lien local
    'fec0::/10',        # site local (obsolète)
    'ff00::/8',         # multicast
)]
_CGNAT = ipaddress.ip_network('100.64.0.0/10')

# Un nom dont le dernier label est un nombre (décimal, octal ou hexadécimal) est
# lu comme une IPv4 par les navigateurs (`http://127.1/`, `http://0x7f.0.0.1/`).
_DERNIER_LABEL_NUMERIQUE = re.compile(r'^(0x[0-9a-f]*|[0-9]+)$', re.IGNORECASE)


def adresse_interdite(ip) -> bool:
    """Vrai pour toute adresse qui n'est pas une adresse publique d'Internet."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return adresse_interdite(ip.ipv4_mapped)
        if any(ip in n for n in _V6_REFUSES):
            return True
    elif ip in _CGNAT:
        return True
    return (
        not ip.is_global or ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def raison_refus(url: str) -> str | None:
    """`None` si l'URL peut être ouverte par le robot, sinon la raison du refus."""
    try:
        parts = urlsplit(str(url).strip())
        host = parts.hostname
    except ValueError:
        return "URL illisible."
    if parts.scheme.lower() not in SCHEMAS_AUTORISES:
        return "Seules les adresses http:// et https:// sont acceptées."
    if not host:
        return "L'adresse doit comporter un nom d'hôte."
    host = host.rstrip('.').lower()

    # Littéral IPv6 entre crochets (urlsplit les retire) ou IPv4 pointée.
    try:
        ip = ipaddress.ip_address(host.split('%', 1)[0])
    except ValueError:
        ip = None
    if ip is not None:
        if adresse_interdite(ip):
            return "Adresse IP interne, de boucle locale ou de lien local : refusée."
        return None

    if host == 'localhost' or host.endswith('.localhost'):
        return "« localhost » est refusé : le robot ne joint qu'Internet."
    if '.' not in host:
        return ("Nom d'hôte sans point (nom de service interne) : refusé — "
                "le robot ne joint qu'Internet.")
    if _DERNIER_LABEL_NUMERIQUE.match(host.rsplit('.', 1)[1]):
        return "Adresse IP écrite sous une forme non standard : refusée."
    return None
