// node --test : verrou `busy` de l'engine (Lot 3). verifyTicket et runSession
// sont simulés : ni Django, ni Playwright.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createEngineServer } from '../app.js';

function deferred() {
  let resolve; const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function start(opts) {
  const engine = createEngineServer(opts);
  await new Promise((r) => engine.server.listen(0, '127.0.0.1', r));
  const { port } = engine.server.address();
  return { ...engine, port, close: () => new Promise((r) => engine.server.close(r)) };
}

function open(port, ticket) {
  return new Promise((resolve) => {
    const q = ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`);
    const messages = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, opened: true, messages }));
    ws.on('error', () => resolve({ ws, opened: false, messages }));
    ws.on('close', () => resolve({ ws, opened: false, messages }));
  });
}

const closed = (ws) => new Promise((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.on('close', r)));

test('un ticket invalide ne prend jamais le verrou', async () => {
  const pending = deferred();
  let sessions = 0;
  const engine = await start({
    verifyTicket: async (t) => {
      if (t === 'lent-invalide') { await pending.promise; throw new Error('Ticket invalide ou expiré.'); }
      if (t !== 'bon') throw new Error('Ticket invalide ou expiré.');
      return { mode: 'record', start_url: 'https://example.org/' };
    },
    runSession: async (ws) => { sessions++; ws.close(); },
  });
  try {
    // Pendant qu'un ticket invalide est en cours de vérification : verrou libre.
    const slow = open(engine.port, 'lent-invalide');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(engine.state.busy, false);

    const bad = await open(engine.port, 'mauvais');
    await closed(bad.ws);
    assert.equal(bad.messages[0]?.type, 'error');
    assert.equal(engine.state.busy, false);

    pending.resolve();
    await closed((await slow).ws);
    assert.equal(engine.state.busy, false);
    assert.equal(sessions, 0);

    // Sans ticket ou mauvais chemin : refus immédiat, verrou libre.
    const none = await open(engine.port);
    assert.equal(none.opened, false);
    assert.equal(engine.state.busy, false);
  } finally {
    await engine.close();
  }
});

test('un ticket valide prend le verrou, une seconde session est refusée, le verrou est rendu', async () => {
  const end = deferred();
  const engine = await start({
    verifyTicket: async (t) => ({ mode: 'record', token: t }),
    runSession: async (ws, ticket) => {
      assert.equal(ticket.token, 'un');
      ws.send(JSON.stringify({ type: 'ready' }));
      await end.promise;
      ws.close();
    },
  });
  try {
    const first = await open(engine.port, 'un');
    assert.equal(first.opened, true);
    assert.equal(engine.state.busy, true);

    const second = await open(engine.port, 'deux');
    assert.equal(second.opened, false);
    assert.equal(engine.state.busy, true);

    end.resolve();
    await closed(first.ws);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.state.busy, false);
  } finally {
    await engine.close();
  }
});

test('une session qui échoue rend le verrou', async () => {
  const engine = await start({
    verifyTicket: async () => ({ mode: 'run' }),
    runSession: async (ws) => { ws.close(); throw new Error('panne'); },
  });
  try {
    const s = await open(engine.port, 'x');
    await closed(s.ws);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(engine.state.busy, false);
  } finally {
    await engine.close();
  }
});

test('client parti pendant la vérification : verrou non pris', async () => {
  const pending = deferred();
  const engine = await start({
    verifyTicket: async () => { await pending.promise; return { mode: 'record' }; },
    runSession: async () => { throw new Error('ne doit pas être appelé'); },
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/ws?ticket=t`);
    ws.on('error', () => {});
    await new Promise((r) => setTimeout(r, 50));
    ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    pending.resolve();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(engine.state.busy, false);
  } finally {
    await engine.close();
  }
});
