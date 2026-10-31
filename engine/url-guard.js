// Destinations que le navigateur piloté a le droit de joindre (Lot 2, contrat
// « urgences » § 7) : Internet seulement, jamais un service du lab.
//
// `robot-lab-engine` est sur `dev-net` et `sso-net` : sans ce filtre, une page
// (URL de départ, redirection, sous-ressource, WebSocket, worker…) pouvait joindre
// `code-server`, `lab-mcp`, `dev-postgres`. Règle :
//   - schéma http/https (ws/wss pour un tunnel WebSocket) ;
//   - nom sans point, `localhost`, `*.localhost` : refusés sans résolution ;
//   - le nom est résolu (dns.promises.lookup, toutes les adresses) et refusé si
//     UNE SEULE adresse est interdite : privée, boucle locale, lien local, CGNAT,
//     réservée, multicast, ou IPv6 portant une IPv4 (mappée, NAT64, 6to4…).
// Échec de résolution ⇒ refus (échec fermé).
//
// Même règle que `backend/api/url_policy.py` (qui ne résout pas) : garder alignés.

import dns from 'node:dns';
import net from 'node:net';

const V4_REFUSES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_REFUSES = [
  ['::', 96],            // non spécifiée, boucle locale ::1, IPv4 « compatible »
  ['::ffff:0:0', 96],    // IPv4 mappée — toutes refusées, publiques comprises
  ['64:ff9b::', 96],     // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],         // discard
  ['2001::', 23],        // IETF, dont Teredo
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4
  ['fc00::', 7],         // ULA
  ['fe80::', 10],        // lien local
  ['fec0::', 10],        // site local
  ['ff00::', 8],         // multicast
];

// Deux listes distinctes : une seule BlockList compare aussi une IPv4 aux règles
// IPv6 sous sa forme mappée (::ffff:0:0/96 y refusait alors toute IPv4).
const BLOCK_V4 = new net.BlockList();
for (const [a, p] of V4_REFUSES) BLOCK_V4.addSubnet(a, p, 'ipv4');
const BLOCK_V6 = new net.BlockList();
for (const [a, p] of V6_REFUSES) BLOCK_V6.addSubnet(a, p, 'ipv6');

/** Vrai pour toute adresse qui n'est pas une adresse publique d'Internet. */
export function isForbiddenAddress(ip) {
  const address = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(address);
  if (family === 4) return BLOCK_V4.check(address, 'ipv4');
  if (family === 6) return BLOCK_V6.check(address, 'ipv6');
  return true;   // illisible : refusé
}

export const HTTP_SCHEMES = new Set(['http:', 'https:']);
export const TUNNEL_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** Refus visible dans l'URL seule, sans DNS. `{ host }` si rien ne s'y oppose. */
export function staticCheck(urlString, schemes = HTTP_SCHEMES) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { reason: 'URL illisible' };
  }
  if (!schemes.has(url.protocol)) return { reason: `schéma ${url.protocol} refusé` };
  // L'analyseur WHATWG a déjà ramené 0x7f.1, 2130706433… à leur forme pointée.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return { reason: 'hôte absent' };
  if (net.isIP(host)) {
    return isForbiddenAddress(host)
      ? { reason: `adresse ${host} interne` }
      : { host, literal: true };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return { reason: 'localhost refusé' };
  if (!host.includes('.')) return { reason: `nom sans point (« ${host} ») refusé` };
  return { host, literal: false };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('délai DNS dépassé')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Filtre avec résolution DNS. `lookup` est injectable (tests : DNS simulé).
 * `isForbidden` aussi, pour les seuls tests de plomberie du proxy.
 *
 * `check(url)` → `{ ok: true, address, family }` (adresse à laquelle se
 * connecter : on se connecte à l'adresse VÉRIFIÉE, jamais à une nouvelle
 * résolution — pas de rebinding DNS) ou `{ ok: false, reason }`.
 */
export function createGuard({
  lookup = dns.promises.lookup,
  isForbidden = isForbiddenAddress,
  cacheMs = 30000,
  dnsTimeoutMs = 5000,
} = {}) {
  const cache = new Map();   // host → { at, promise }

  async function resolveHost(host) {
    let addresses;
    try {
      addresses = await withTimeout(lookup(host, { all: true, verbatim: true }), dnsTimeoutMs);
    } catch (err) {
      return { ok: false, reason: `résolution de ${host} impossible (${err.code || err.message})` };
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return { ok: false, reason: `aucune adresse pour ${host}` };
    }
    const bad = addresses.find((a) => isForbidden(a.address));
    if (bad) return { ok: false, reason: `${host} résout vers une adresse interne (${bad.address})` };
    return { ok: true, address: addresses[0].address, family: addresses[0].family };
  }

  async function check(urlString, schemes = HTTP_SCHEMES) {
    const s = staticCheck(urlString, schemes);
    if (s.reason) return { ok: false, reason: s.reason };
    if (s.literal) {
      if (isForbidden(s.host)) return { ok: false, reason: `adresse ${s.host} interne` };
      return { ok: true, address: s.host, family: net.isIP(s.host) };
    }
    const now = Date.now();
    const hit = cache.get(s.host);
    if (hit && now - hit.at < cacheMs) return hit.promise;
    const promise = resolveHost(s.host);
    cache.set(s.host, { at: now, promise });
    return promise;
  }

  return { check };
}

/**
 * À appeler avant tout `page.goto` : `context.route` ne voit pas `file:`,
 * `chrome:`, `view-source:`… (un `goto` vers `file:///proc/self/environ`
 * afficherait l'environnement de l'engine dans la vue live). Le reste du filtre
 * (DNS) est appliqué par `context.route` et le proxy de sortie.
 */
export function assertNavigable(urlString) {
  const s = staticCheck(urlString);
  if (s.reason) throw new Error(`Adresse refusée (${s.reason}) : le robot ne joint qu'Internet.`);
}
