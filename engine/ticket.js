// Vérification d'un ticket de session auprès de Django (usage unique).
// Séparé de session.js pour que server.js puisse valider le ticket AVANT de
// prendre le verrou `busy`, sans charger Playwright.

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://robot-lab-backend:8000';
const ENGINE_KEY = process.env.ENGINE_INTERNAL_KEY || '';

export async function verifyTicket(token) {
  // Un backend lent/injoignable ne doit jamais bloquer l'upgrade indéfiniment —
  // fetch() n'a pas de timeout par défaut, on en pose un explicitement.
  const res = await fetch(`${BACKEND_URL}/api/internal/verify-ticket/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Engine-Key': ENGINE_KEY },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Ticket refusé (${res.status})`);
  }
  return res.json();
}
