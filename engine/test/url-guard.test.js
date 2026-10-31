// node --test : filtre de destinations, DNS simulé (aucune résolution réelle).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGuard, isForbiddenAddress, staticCheck, TUNNEL_SCHEMES } from '../url-guard.js';

// DNS simulé : ce que résoudrait le DNS de Docker dans le conteneur, plus des
// noms publics de test.
const ZONE = {
  'code-server': ['172.18.0.7'],
  'public.example': ['93.184.215.14'],
  'v6.example': ['2606:4700:4700::1111'],
  'interne.example': ['10.1.2.3'],
  'mixte.example': ['93.184.215.14', '192.168.1.10'],
  'rebind.example': ['127.0.0.1'],
  'cgnat.example': ['100.64.3.4'],
  'mapped.example': ['::ffff:10.0.0.1'],
  'code-server.': ['172.18.0.7'],
};
function fakeLookup(calls = []) {
  return async (host, opts) => {
    calls.push(host);
    assert.equal(opts.all, true);
    const list = ZONE[host];
    if (!list) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

test('adresses interdites', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1',
    '127.255.255.254', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1',
    'ff02::1', 'pas-une-ip', '']) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
  for (const ip of ['93.184.215.14', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1',
    '2606:4700:4700::1111', '2a00:1450:4007:80c::200e']) {
    assert.equal(isForbiddenAddress(ip), false, ip);
  }
});

test('refus sans DNS : schéma, localhost, nom sans point, IP littérale', () => {
  const refusees = [
    'http://code-server:8091', 'http://code-server:8091/', 'http://code-server.:8091/',
    'http://10.0.0.1', 'http://localhost', 'http://localhost:4300/ws', 'http://app.localhost/',
    'http://[::1]', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://127.1/',
    'http://0x7f.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://user:pw@10.0.0.1/',
    'file:///etc/passwd', 'ftp://ftp.example.org/', 'chrome://settings', 'javascript:alert(1)',
    'view-source:http://example.org/', 'pas une url',
  ];
  for (const url of refusees) assert.ok(staticCheck(url).reason, url);
  assert.equal(staticCheck('https://public.example/').host, 'public.example');
  assert.ok(staticCheck('wss://public.example/').reason, 'ws refusé hors tunnel');
  assert.equal(staticCheck('wss://public.example/', TUNNEL_SCHEMES).host, 'public.example');
});

test('résolution : une seule adresse interne suffit à refuser', async () => {
  const guard = createGuard({ lookup: fakeLookup() });
  assert.deepEqual(await guard.check('https://public.example/a'),
    { ok: true, address: '93.184.215.14', family: 4 });
  assert.equal((await guard.check('https://v6.example/')).ok, true);
  for (const url of ['https://interne.example/', 'https://mixte.example/', 'http://rebind.example/',
    'http://cgnat.example/', 'http://mapped.example/', 'http://inconnu.example/']) {
    const v = await guard.check(url);
    assert.equal(v.ok, false, url);
    assert.ok(v.reason, url);
  }
});

test('IP littérale publique acceptée sans DNS', async () => {
  const calls = [];
  const guard = createGuard({ lookup: fakeLookup(calls) });
  assert.equal((await guard.check('https://8.8.8.8/')).address, '8.8.8.8');
  assert.equal((await guard.check('https://[2606:4700:4700::1111]/')).ok, true);
  assert.deepEqual(calls, []);
});

test('noms internes refusés avant toute résolution', async () => {
  const calls = [];
  const guard = createGuard({ lookup: fakeLookup(calls) });
  for (const url of ['http://code-server:8091', 'http://code-server.:8091/', 'http://localhost',
    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'file:///etc/passwd']) {
    assert.equal((await guard.check(url)).ok, false, url);
  }
  assert.deepEqual(calls, []);
});

test('DNS qui ne répond pas : refus (échec fermé)', async () => {
  const guard = createGuard({ lookup: () => new Promise(() => {}), dnsTimeoutMs: 50 });
  const v = await guard.check('https://lent.example/');
  assert.equal(v.ok, false);
});

test('cache : un nom n\'est résolu qu\'une fois par fenêtre', async () => {
  const calls = [];
  const guard = createGuard({ lookup: fakeLookup(calls) });
  await Promise.all([guard.check('https://public.example/1'), guard.check('https://public.example/2')]);
  await guard.check('https://public.example/3');
  assert.equal(calls.length, 1);
});
