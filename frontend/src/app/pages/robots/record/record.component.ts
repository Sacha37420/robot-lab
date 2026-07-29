import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, RobotStep } from '../../../core/api.service';

type EngineMessage =
  | { type: 'ready'; startUrl: string }
  | { type: 'frame'; data: string }
  | { type: 'step'; step: RobotStep }
  | { type: 'final'; steps: RobotStep[] }
  | { type: 'dialog'; kind: string; message: string; defaultValue: string }
  | { type: 'note'; note: string }
  | { type: 'error'; message: string };

/** Boîte de dialogue du navigateur en attente d'une réponse de l'utilisateur.
 *  Elle n'apparaît pas dans la vue live (elle est au niveau du navigateur, pas
 *  de la page), d'où ce panneau dédié. */
interface PendingDialog {
  kind: string;
  message: string;
  value: string;
}

@Component({
  selector: 'app-record',
  standalone: true,
  imports: [RouterLink, FormsModule],
  templateUrl: './record.component.html',
  styleUrl: './record.component.scss',
})
export class RecordComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private robotId = Number(this.route.snapshot.paramMap.get('id'));
  private ws: WebSocket | null = null;

  @ViewChild('liveImg') private liveImgRef?: ElementRef<HTMLImageElement>;

  status = signal<'connecting' | 'live' | 'stopping' | 'error'>('connecting');
  errorMessage = signal<string | null>(null);
  frameSrc = signal<string | null>(null);
  steps = signal<RobotStep[]>([]);
  dialog = signal<PendingDialog | null>(null);
  notes = signal<string[]>([]);

  ngOnInit(): void {
    this.api.getRecordingTicket(this.robotId).subscribe({
      next: ({ ticket }) => this.connect(ticket),
      error: () => {
        this.status.set('error');
        this.errorMessage.set("Impossible d'obtenir un ticket de session (un enregistrement est peut-être déjà en cours).");
      },
    });
  }

  ngOnDestroy(): void {
    this.ws?.close();
  }

  private connect(ticket: string): void {
    const ws = new WebSocket(`${this.api.engineUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;

    ws.onmessage = (event) => this.handleMessage(JSON.parse(event.data) as EngineMessage);
    ws.onerror = () => {
      this.status.set('error');
      this.errorMessage.set('Connexion au moteur perdue.');
    };
    ws.onclose = () => {
      if (this.status() !== 'stopping') this.status.set('error');
    };
  }

  private handleMessage(msg: EngineMessage): void {
    switch (msg.type) {
      case 'ready':
        this.status.set('live');
        break;
      case 'frame':
        this.frameSrc.set(`data:image/jpeg;base64,${msg.data}`);
        break;
      case 'step':
        this.steps.update(steps => [...steps, msg.step]);
        break;
      case 'final':
        this.status.set('stopping');
        this.api.updateRobotSteps(this.robotId, msg.steps).subscribe({
          next: () => this.router.navigate(['/robots']),
          error: () => {
            this.status.set('error');
            this.errorMessage.set("Les étapes n'ont pas pu être enregistrées.");
          },
        });
        break;
      // Le site pose une question au navigateur : la page reste bloquée jusqu'à
      // la réponse, donc on la demande tout de suite à l'utilisateur.
      case 'dialog':
        this.dialog.set({ kind: msg.kind, message: msg.message, value: msg.defaultValue || '' });
        break;

      case 'note':
        this.notes.update(n => [...n, msg.note]);
        break;

      case 'error':
        this.status.set('error');
        this.errorMessage.set(msg.message);
        break;
    }
  }

  /** Répond à la boîte de dialogue. La réponse est enregistrée comme étape et
   *  sera rejouée telle quelle au lancement du robot. */
  answerDialog(accept: boolean): void {
    const pending = this.dialog();
    if (!pending) return;
    this.ws?.send(JSON.stringify({
      type: 'dialog_answer',
      accept,
      value: pending.kind === 'prompt' ? pending.value : '',
    }));
    this.dialog.set(null);
  }

  stop(): void {
    this.ws?.send(JSON.stringify({ type: 'stop' }));
  }

  onMouseEvent(event: MouseEvent, action: 'move' | 'down' | 'up'): void {
    if (this.status() !== 'live' || !this.ws) return;
    const coords = this.toPageCoords(event);
    if (!coords) return;
    this.ws.send(JSON.stringify({ type: 'mouse', action, x: coords.x, y: coords.y, button: 'left' }));
  }

  onWheel(event: WheelEvent): void {
    if (this.status() !== 'live' || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY }));
    event.preventDefault();
  }

  onKeyDown(event: KeyboardEvent): void {
    if (this.status() !== 'live' || !this.ws) return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.ws.send(JSON.stringify({ type: 'type', text: event.key }));
      return;
    }
    this.ws.send(JSON.stringify({ type: 'key', action: 'down', key: event.key }));
  }

  onKeyUp(event: KeyboardEvent): void {
    if (this.status() !== 'live' || !this.ws) return;
    if (event.key.length === 1) return; // déjà envoyé comme 'type' au keydown
    this.ws.send(JSON.stringify({ type: 'key', action: 'up', key: event.key }));
  }

  private toPageCoords(event: MouseEvent): { x: number; y: number } | null {
    const img = this.liveImgRef?.nativeElement;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }
}
