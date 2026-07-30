import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

interface EnvWindow {
  __env?: { apiUrl?: string; engineUrl?: string };
}

export type AIProvider = 'claude' | 'mistral';

export interface AIProviderConfig {
  provider: AIProvider;
  model_name: string;
  has_key: boolean;
  updated_at: string;
}

/** Point d'impact d'un clic DANS l'élément (w/h : ses dimensions à
 *  l'enregistrement, pour replacer le point si la taille a changé). Ne sert
 *  jamais à identifier l'élément — c'est le rôle du sélecteur. */
export interface StepPosition {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface RobotStep {
  action: string;
  selector?: string;
  value?: string;
  variable?: string;
  url?: string;
  text?: string;
  key?: string;
  masked?: boolean;
  position?: StepPosition;
  /** Position de défilement de la page (action `scroll`). */
  x?: number;
  y?: number;
  /** Réponse à une boîte de dialogue du navigateur (action `dialog`). */
  kind?: string;
  message?: string;
  accept?: boolean;
  objective?: string;
  expected_result?: string;
  values?: string[];
  /** HTML capturé autour de l'élément à l'enregistrement, du plus étroit au
   *  plus large — contexte donné à l'assistant de modification, jamais
   *  éditable à la main (cf. INTERNAL_FIELDS côté backend). */
  context?: string[];
}

export type RobotVariables = Record<string, string[]>;

export type RunLogState = 'done' | 'failed';

export interface RunLogLine {
  index: number;
  label: string;
  state: RunLogState;
  note?: string;
}

/** Résultat conservé du dernier test mené à son terme — `null` si aucun test
 *  n'a encore été lancé pour ce robot. */
export interface LastRun {
  status: 'success' | 'failed' | 'error' | 'stopped';
  status_display: string;
  created_at: string;
  finished_at: string;
  log: RunLogLine[];
  error_message: string;
}

export interface Robot {
  id: number;
  name: string;
  description: string;
  start_url: string;
  steps: RobotStep[];
  variables: RobotVariables;
  /** Calculé par le serveur : ce qui empêcherait le robot de faire son travail
   *  (boucle sans valeur…). Vide quand tout va bien. */
  warnings: string[];
  last_run: LastRun | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantProposal {
  steps: RobotStep[];
  variables: RobotVariables;
  explanation: string;
  warnings: string[];
}

/** Un tour de conversation renvoyé à l'assistant pour qu'il garde le fil.
 *  Reconstruit côté client à chaque appel — rien n'est stocké en base. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Vocabulaire d'étapes servi par le backend (`GET /api/step-schema/`) : le
 *  frontend n'en tient pas de copie, elle dériverait. */
export interface StepFieldSchema {
  name: string;
  label: string;
  type: 'string' | 'multiline' | 'boolean' | 'number' | 'string-list' | 'position';
  required: boolean;
}

export interface StepActionSchema {
  action: string;
  label: string;
  /** Faux pour les actions qui portent un `selector` capturé sur le vrai site :
   *  les créer à la main revient à inventer un sélecteur. */
  addable: boolean;
  fields: StepFieldSchema[];
}

export type RobotInput = Pick<Robot, 'name' | 'description' | 'start_url'>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get base(): string {
    return (window as unknown as EnvWindow).__env?.apiUrl
      ?? 'http://localhost:8094';
  }

  get engineUrl(): string {
    return (window as unknown as EnvWindow).__env?.engineUrl
      ?? 'ws://localhost:8095';
  }

  getAiConfig(provider: AIProvider): Observable<AIProviderConfig> {
    return this.http.get<AIProviderConfig>(`${this.base}/api/ai-config/${provider}/`);
  }

  saveAiConfig(provider: AIProvider, payload: { api_key?: string; model_name?: string }): Observable<AIProviderConfig> {
    return this.http.put<AIProviderConfig>(`${this.base}/api/ai-config/${provider}/`, payload);
  }

  getRobots(): Observable<Robot[]> {
    return this.http.get<Robot[]>(`${this.base}/api/robots/`);
  }

  createRobot(payload: RobotInput): Observable<Robot> {
    return this.http.post<Robot>(`${this.base}/api/robots/`, payload);
  }

  updateRobot(id: number, payload: RobotInput): Observable<Robot> {
    return this.http.patch<Robot>(`${this.base}/api/robots/${id}/`, payload);
  }

  deleteRobot(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/robots/${id}/`);
  }

  getRobot(id: number): Observable<Robot> {
    return this.http.get<Robot>(`${this.base}/api/robots/${id}/`);
  }

  getRecordingTicket(id: number): Observable<{ ticket: string }> {
    return this.http.post<{ ticket: string }>(`${this.base}/api/robots/${id}/recording-ticket/`, {});
  }

  getRunTicket(id: number, provider?: AIProvider): Observable<{ ticket: string; run_id: number }> {
    return this.http.post<{ ticket: string; run_id: number }>(
      `${this.base}/api/robots/${id}/run-ticket/`, provider ? { provider } : {},
    );
  }

  /** Consigne le résultat d'une exécution terminée — `engine/` ne peut pas le
   *  faire lui-même (aucun droit d'écriture en base), c'est donc le frontend,
   *  qui porte le vrai jeton de la personne, qui le rapporte une fois la
   *  session WebSocket close. Sert à la fois à l'afficher dans l'éditeur et à
   *  le donner en contexte à l'assistant. */
  reportRunResult(
    robotId: number, runId: number,
    result: { status: string; log: RunLogLine[]; message?: string },
  ): Observable<void> {
    return this.http.post<void>(
      `${this.base}/api/robots/${robotId}/runs/${runId}/result/`, result,
    );
  }

  /** Récupère un fichier téléchargé par le robot. Le serveur le supprime ensuite. */
  fetchDownload(runId: number, name: string): Observable<Blob> {
    return this.http.get(
      `${this.base}/api/runs/${runId}/downloads/${encodeURIComponent(name)}/`,
      { responseType: 'blob' },
    );
  }

  /** Valeurs des variables sur lesquelles boucler — modifiables sans repasser
   *  par l'assistant, qui ne peut pas les deviner. */
  updateRobotVariables(id: number, variables: RobotVariables): Observable<Robot> {
    return this.http.patch<Robot>(`${this.base}/api/robots/${id}/`, { variables });
  }

  updateRobotSteps(id: number, steps: RobotStep[], variables?: RobotVariables): Observable<Robot> {
    const payload: { steps: RobotStep[]; variables?: RobotVariables } = { steps };
    if (variables) payload.variables = variables;
    return this.http.patch<Robot>(`${this.base}/api/robots/${id}/`, payload);
  }

  getStepSchema(): Observable<{ actions: StepActionSchema[] }> {
    return this.http.get<{ actions: StepActionSchema[] }>(`${this.base}/api/step-schema/`);
  }

  askAssistant(
    id: number, instruction: string, provider: AIProvider, history: ChatTurn[] = [],
  ): Observable<AssistantProposal> {
    return this.http.post<AssistantProposal>(
      `${this.base}/api/robots/${id}/assistant/`, { instruction, provider, history },
    );
  }
}
