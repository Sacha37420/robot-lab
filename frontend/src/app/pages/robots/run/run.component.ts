import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';

type EngineMessage =
  | { type: 'ready'; startUrl: string; mode: string }
  | { type: 'frame'; data: string }
  | { type: 'plan'; total: number }
  | { type: 'progress'; index: number; total: number; label: string }
  | { type: 'download'; name: string; size: number }
  | { type: 'failed'; index: number; label: string; message: string }
  | { type: 'finished'; total: number }
  | { type: 'error'; message: string };

interface LogLine {
  label: string;
  state: 'running' | 'done' | 'failed';
}

interface DownloadedFile {
  name: string;
  size: number;
  state: 'fetching' | 'saved' | 'error';
}

@Component({
  selector: 'app-run',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './run.component.html',
  styleUrl: './run.component.scss',
})
export class RunComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  private robotId = Number(this.route.snapshot.paramMap.get('id'));
  private ws: WebSocket | null = null;
  private runId = 0;

  status = signal<'connecting' | 'running' | 'finished' | 'failed'>('connecting');
  message = signal<string | null>(null);
  frameSrc = signal<string | null>(null);
  progress = signal<{ index: number; total: number } | null>(null);
  log = signal<LogLine[]>([]);
  files = signal<DownloadedFile[]>([]);

  ngOnInit(): void {
    this.api.getRunTicket(this.robotId).subscribe({
      next: ({ ticket, run_id }) => { this.runId = run_id; this.connect(ticket); },
      error: (err) => {
        this.status.set('failed');
        this.message.set(
          err?.error?.detail ?? "Impossible de lancer ce robot (une exécution est peut-être déjà en cours).",
        );
      },
    });
  }

  ngOnDestroy(): void {
    this.ws?.close();
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
        // L'étape précédente est terminée dès que la suivante commence.
        this.log.update(lines => [
          ...lines.map(l => (l.state === 'running' ? { ...l, state: 'done' as const } : l)),
          { label: msg.label, state: 'running' },
        ]);
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
        break;

      case 'finished':
        this.status.set('finished');
        this.log.update(lines =>
          lines.map(l => (l.state === 'running' ? { ...l, state: 'done' as const } : l)),
        );
        break;

      case 'error':
        this.status.set('failed');
        this.message.set(msg.message);
        break;
    }
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
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
    return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  }
}
