import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Serveur de l'engine, sans Playwright : `verifyTicket` et `runSession` sont
 * injectés (server.js donne les vrais, les tests des faux).
 *
 * Un seul run à la fois — même principe que runner/server.js (contrainte
 * 2 vCPU/16 Go du serveur, cf. CLAUDE.md).
 *
 * Le verrou `busy` n'est pris qu'APRÈS la validation du ticket (Lot 3) : avant,
 * n'importe quelle connexion anonyme avec un `?ticket=` quelconque le prenait le
 * temps de l'aller-retour vers Django et refusait les vraies sessions.
 */
export function createEngineServer({ verifyTicket, runSession }) {
  const app = express();
  const state = { busy: false };

  app.get('/healthz', (_req, res) => res.json({ ok: true, busy: state.busy }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://engine'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const token = url.searchParams.get('ticket');
    if (!token) { socket.destroy(); return; }
    // Refus immédiat si occupé : le ticket n'est pas consommé, l'utilisateur
    // peut réessayer avec le même.
    if (state.busy) { socket.destroy(); return; }

    let ticket = null;
    let refusal = null;
    try {
      ticket = await verifyTicket(token);
    } catch (err) {
      refusal = String(err.message || err);
    }

    if (refusal !== null) {
      // Ticket invalide : on dit pourquoi puis on ferme — sans jamais toucher
      // au verrou.
      if (!socket.readable || !socket.writable) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'error', message: refusal }));
        ws.close(1008, 'ticket refusé');
      });
      return;
    }

    // Un autre ticket a pu être validé pendant notre propre vérification.
    if (state.busy || !socket.readable || !socket.writable) { socket.destroy(); return; }
    state.busy = true;
    let started = false;
    // Si `ws` abandonne l'upgrade (socket fermée entre-temps), le rappel n'est
    // jamais appelé : sans ceci le verrou resterait pris à vie.
    socket.once('close', () => { if (!started) state.busy = false; });
    wss.handleUpgrade(req, socket, head, (ws) => {
      started = true;
      Promise.resolve()
        .then(() => runSession(ws, ticket))
        .catch(() => {})
        .finally(() => { state.busy = false; });
    });
  });

  return { server, state };
}
