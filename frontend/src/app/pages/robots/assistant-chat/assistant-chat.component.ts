import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AIProvider, ApiService, AssistantProposal, ChatTurn,
} from '../../../core/api.service';

/** Un message du fil. Les tours de l'assistant portent la proposition qui les
 *  accompagne, pour pouvoir l'appliquer plus tard dans la conversation. */
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  proposal?: AssistantProposal;
  /** Proposition déjà chargée dans l'éditeur — évite de l'appliquer deux fois. */
  applied?: boolean;
  failed?: boolean;
}

@Component({
  selector: 'app-assistant-chat',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './assistant-chat.component.html',
  styleUrl: './assistant-chat.component.scss',
})
export class AssistantChatComponent {
  private api = inject(ApiService);

  @Input({ required: true }) robotId!: number;

  /** Proposition acceptée : chargée dans l'éditeur, pas enregistrée. C'est
   *  toujours le bouton « Enregistrer » de l'éditeur qui écrit en base. */
  @Output() apply = new EventEmitter<AssistantProposal>();

  messages = signal<ChatMessage[]>([]);
  instruction = '';
  provider: AIProvider = 'claude';
  asking = signal(false);

  send(): void {
    const instruction = this.instruction.trim();
    if (!instruction || this.asking()) return;

    // L'historique part AVANT d'ajouter le message courant : le backend ajoute
    // lui-même le tour utilisateur, avec le parcours à jour en préambule.
    const history: ChatTurn[] = this.messages()
      .filter((m) => !m.failed)
      .map((m) => ({ role: m.role, content: m.content }));

    this.messages.update((list) => [...list, { role: 'user', content: instruction }]);
    this.instruction = '';
    this.asking.set(true);

    this.api.askAssistant(this.robotId, instruction, this.provider, history).subscribe({
      next: (proposal) => {
        this.asking.set(false);
        this.messages.update((list) => [...list, {
          role: 'assistant',
          content: proposal.explanation || '(aucune explication)',
          proposal,
        }]);
      },
      error: (err) => {
        this.asking.set(false);
        this.messages.update((list) => [...list, {
          role: 'assistant',
          content: err?.error?.detail ?? "L'assistant n'a pas pu répondre.",
          // Marqué en échec : ce tour n'est pas renvoyé dans l'historique, il ne
          // dit rien du parcours.
          failed: true,
        }]);
      },
    });
  }

  applyProposal(message: ChatMessage): void {
    if (!message.proposal || message.applied) return;
    this.apply.emit(message.proposal);
    this.messages.update((list) =>
      list.map((m) => (m === message ? { ...m, applied: true } : m)),
    );
  }

  clear(): void {
    this.messages.set([]);
  }
}
