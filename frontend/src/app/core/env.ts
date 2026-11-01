/**
 * Configuration injectée au démarrage du conteneur (`assets/env.js`, écrit par
 * `nginx-entrypoint.sh`).
 */
export interface LabEnv {
  keycloakUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  appUrl?: string;
  apiUrl?: string;
  engineUrl?: string;
}

export function labEnv(): LabEnv {
  return (window as unknown as { __env?: LabEnv }).__env ?? {};
}

/** Base de l'API de robot-lab (`…/robot-lab-api`). */
export function apiUrl(): string {
  return labEnv().apiUrl ?? 'http://localhost:8094';
}

/**
 * Base WebSocket de l'engine (`…/robot-lab-engine`). Il n'est joint que par
 * WebSocket, avec un ticket à usage unique délivré par l'API : jamais par
 * HttpClient, donc jamais avec le jeton.
 */
export function engineUrl(): string {
  return labEnv().engineUrl ?? 'ws://localhost:8095';
}

/**
 * Les SEULES adresses auxquelles le jeton de l'utilisateur est joint
 * (`auth.interceptor.ts`, `token-scope.ts`) : l'API de l'app, rien d'autre —
 * l'engine reçoit un ticket, pas le jeton, et aucun autre service n'est appelé.
 */
export function tokenBases(): string[] {
  return [apiUrl()];
}
