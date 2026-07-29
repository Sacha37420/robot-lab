import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

interface EnvWindow {
  __env?: { apiUrl?: string };
}

export type AIProvider = 'claude' | 'mistral';

export interface AIProviderConfig {
  provider: AIProvider;
  model_name: string;
  has_key: boolean;
  updated_at: string;
}

export interface Robot {
  id: number;
  name: string;
  description: string;
  start_url: string;
  steps: unknown[];
  created_at: string;
  updated_at: string;
}

export type RobotInput = Pick<Robot, 'name' | 'description' | 'start_url'>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get base(): string {
    return (window as unknown as EnvWindow).__env?.apiUrl
      ?? 'http://localhost:8094';
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
}
