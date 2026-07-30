import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AIProvider, ApiService, Robot, RunLogLine } from '../../../core/api.service';

type EngineMessage =
  | { type: 'ready'; startUrl: string; mode: string }
  | { type: 'frame'; data: string }
  | { type: 'plan'; total: number }
  | { type: 'progress'; index: number; total: number; label: string }
  | { type: 'ai_action'; turn: number; total: number; label: string; reasoning: string }
  | { type: 'ai_done'; note: string }
  | { type: 'note'; index: number; note: string }
  | { type: 'download'; name: string; size: number }
  | { type: 'failed'; index: number; label: string; message: string }
  | { type: 'finished'; total: number }
  | { type: 'error'; message: string };

interface LogLine {
  label: string;
  state: 'running' | 'done' | 'failed';
  /** Ligne produite par le pilote IA — affichée en retrait, avec son raisonnement. */
  ai?: boolean;
  reasoning?: string;
}

interface DownloadedFile {
  name: string;
  size: number;
  state: 'fetching' | 'saved' | 'error';
}

@Component({
  selector: 'app-run',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './run.component.html',
  styleUrl: './run.component.scss',
})
export class RunComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  private robotId = Number(this.route.snapshot.paramMap.get('id'));
  private ws: WebSocket | null = null;
  private runId = 0;

  robot = signal<Robot | null>(null);
  needsAi = signal(false);
  provider: AIProvider = 'claude';

  status = signal<'loading' | 'ready' | 'connecting' | 'running' | 'finished' | 'failed'>('loading');
  message = signal<string | null>(null);
  frameSrc = signal<string | null>(null);
  progress = signal<{ index: number; total: number } | null>(null);
  log = signal<LogLine[]>([]);
  files = signal<DownloadedFile[]>([]);

  ngOnInit(): void {
    this.api.getRobot(this.robotId).subscribe({
      next: (robot) => {
        this.robot.set(robot);
        // Le choix du fournisseur n'est demandé que si le parcours en a besoin.
        this.needsAi.set(robot.steps.some(s => s.action === 'ai_task'));
        this.status.set('ready');
      },
      error: () => {
        this.status.set('failed');
        this.message.set('Impossible de charger ce robot.');
      },
    });
  }

  ngOnDestroy(): void {
    this.ws?.close();
  }

  start(): void {
    this.status.set('connecting');
    this.message.set(null);
    this.log.set([]);
    this.files.set([]);
    this.progress.set(null);

    this.api.getRunTicket(this.robotId, this.needsAi() ? this.provider : undefined).subscribe({
      next: ({ ticket, run_id }) => { this.runId = run_id; this.connect(ticket); },
      error: (err) => {
        this.status.set('failed');
        this.message.set(
          err?.error?.detail ?? "Impossible de lancer ce robot (une exécution est peut-être déjà en cours).",
        );
      },
    });
  }

  private connect(ticket: string): void {
    const ws = new WebSocket(`${this.api.engineUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;

    ws.onmessage = (event) => this.handle(JSON.parse(event.data) as EngineMessage);
    ws.onerror = () => {
      if (this.status() === 'connecting' || this.status() === 'running') {
        this.status.set('failed');
        this.message.set('Connexion au moteur perdue.');
      }
    };
    ws.onclose = () => {
      if (this.status() === 'connecting' || this.status() === 'running') {
        this.status.set('failed');
        this.message.set(this.message() ?? 'La session a été interrompue.');
        this.reportResult('error', this.message() ?? undefined);
      }
    };
  }

  private handle(msg: EngineMessage): void {
    switch (msg.type) {
      case 'ready':
        this.status.set('running');
        break;

      case 'frame':
        this.frameSrc.set(`data:image/jpeg;base64,${msg.data}`);
        break;

      case 'plan':
        this.progress.set({ index: 0, total: msg.total });
        break;

      case 'progress':
        this.progress.set({ index: msg.index, total: msg.total });
        this.closeRunning();
        this.log.update(lines => [...lines, { label: msg.label, state: 'running' }]);
        break;

      case 'ai_action':
        this.log.update(lines => [...lines, {
          label: `IA (tour ${msg.turn}/${msg.total}) — ${msg.label}`,
          state: 'done',
          ai: true,
          reasoning: msg.reasoning,
        }]);
        break;

      case 'ai_done':
        this.log.update(lines => [...lines, {
          label: `IA : ${msg.note}`, state: 'done', ai: true,
        }]);
        break;

      // Le rejeu a réussi mais s'est écarté du chemin nominal : on l'affiche
      // sous l'étape concernée plutôt que de laisser croire à un run parfait.
      case 'note':
        this.log.update(lines => [...lines, {
          label: `Étape ${msg.index} — ${msg.note}`, state: 'done', ai: true,
        }]);
        break;

      case 'download':
        this.saveFile(msg.name, msg.size);
        break;

      case 'failed':
        this.status.set('failed');
        this.message.set(`Étape ${msg.index} — ${msg.label} : ${msg.message}`);
        this.log.update(lines =>
          lines.map(l => (l.state === 'running' ? { ...l, state: 'failed' as const } : l)),
        );
        this.reportResult('failed', msg.message);
        break;

      case 'finished':
        this.status.set('finished');
        this.closeRunning();
        this.reportResult('success');
        break;

      case 'error':
        this.status.set('failed');
        this.message.set(msg.message);
        this.reportResult('error', msg.message);
        break;
    }
  }

  /** Consigne le résultat en base une fois l'exécution terminée — sans ça, le
   *  résultat ne survivait pas à la fermeture de l'onglet, et l'assistant de
   *  modification ne pouvait jamais savoir si le parcours avait déjà été
   *  essayé. Best-effort : un échec de ce rapport n'affecte pas ce que la
   *  personne voit déjà en direct dans le journal. */
  private reportResult(status: string, message?: string): void {
    if (!this.runId) return;
    const log: RunLogLine[] = this.log().map((line, i) => ({
      index: i + 1,
      label: line.label,
      state: line.state === 'failed' ? 'failed' : 'done',
    }));
    this.api.reportRunResult(this.robotId, this.runId, { status, log, message }).subscribe({
      error: () => { /* best-effort — non bloquant pour l'utilisateur */ },
    });
  }

  private closeRunning(): void {
    this.log.update(lines =>
      lines.map(l => (l.state === 'running' ? { ...l, state: 'done' as const } : l)),
    );
  }

  /** Récupère le fichier et déclenche l'enregistrement côté navigateur.
   *  Le serveur le supprime au passage — il n'en reste aucune copie. */
  private saveFile(name: string, size: number): void {
    this.files.update(f => [...f, { name, size, state: 'fetching' }]);

    this.api.fetchDownload(this.runId, name).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
        this.patchFile(name, 'saved');
      },
      error: () => this.patchFile(name, 'error'),
    });
  }

  private patchFile(name: string, state: DownloadedFile['state']): void {
    this.files.update(f => f.map(item => (item.name === name ? { ...item, state } : item)));
  }

  stop(): void {
    this.ws?.send(JSON.stringify({ type: 'stop' }));
    this.ws?.close();
    this.status.set('finished');
    this.reportResult('stopped');
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
    return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  }
}
