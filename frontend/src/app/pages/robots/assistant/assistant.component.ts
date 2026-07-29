import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  AIProvider, ApiService, AssistantProposal, Robot, RobotStep,
} from '../../../core/api.service';

/** Une ligne du comparatif avant/après, alignée par position. */
interface DiffRow {
  index: number;
  before: RobotStep | null;
  after: RobotStep | null;
  status: 'unchanged' | 'changed' | 'added' | 'removed';
}

@Component({
  selector: 'app-assistant',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  private robotId = Number(this.route.snapshot.paramMap.get('id'));

  robot = signal<Robot | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  instruction = '';
  provider: AIProvider = 'claude';

  asking = signal(false);
  proposal = signal<AssistantProposal | null>(null);
  applying = signal(false);
  applied = signal(false);

  ngOnInit(): void {
    this.api.getRobot(this.robotId).subscribe({
      next: (robot) => { this.robot.set(robot); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.error.set('Impossible de charger ce robot.');
      },
    });
  }

  ask(): void {
    if (!this.instruction.trim()) return;
    this.asking.set(true);
    this.error.set(null);
    this.proposal.set(null);
    this.applied.set(false);

    this.api.askAssistant(this.robotId, this.instruction, this.provider).subscribe({
      next: (proposal) => { this.proposal.set(proposal); this.asking.set(false); },
      error: (err) => {
        this.asking.set(false);
        this.error.set(err?.error?.detail ?? "L'assistant n'a pas pu répondre.");
      },
    });
  }

  apply(): void {
    const proposal = this.proposal();
    if (!proposal) return;
    this.applying.set(true);
    this.error.set(null);

    this.api.updateRobotSteps(this.robotId, proposal.steps, proposal.variables).subscribe({
      next: (robot) => {
        this.robot.set(robot);
        this.proposal.set(null);
        this.applying.set(false);
        this.applied.set(true);
        this.instruction = '';
      },
      error: (err) => {
        this.applying.set(false);
        this.error.set(err?.error?.steps?.[0] ?? "Les modifications n'ont pas pu être enregistrées.");
      },
    });
  }

  reject(): void {
    this.proposal.set(null);
  }

  /** Comparatif position par position — suffisant tant que l'IA renvoie le parcours complet. */
  diff(): DiffRow[] {
    const before = this.robot()?.steps ?? [];
    const after = this.proposal()?.steps ?? [];
    const rows: DiffRow[] = [];

    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const b = before[i] ?? null;
      const a = after[i] ?? null;
      let status: DiffRow['status'];
      if (b && !a) status = 'removed';
      else if (!b && a) status = 'added';
      else status = JSON.stringify(b) === JSON.stringify(a) ? 'unchanged' : 'changed';
      rows.push({ index: i + 1, before: b, after: a, status });
    }
    return rows;
  }

  changedCount(): number {
    return this.diff().filter(r => r.status !== 'unchanged').length;
  }

  /** Résumé lisible d'une étape — l'utilisateur ne doit pas avoir à lire du JSON. */
  describe(step: RobotStep | null): string {
    if (!step) return '—';
    switch (step.action) {
      case 'goto':       return `Ouvrir ${step.url}`;
      case 'click':      return `Cliquer ${step.text ? `« ${step.text} »` : step.selector}`;
      case 'fill':       return step.masked
        ? `Remplir ${step.selector} (mot de passe, non enregistré)`
        : `Remplir ${step.selector} avec ${step.variable ? `la variable « ${step.variable} »` : `« ${step.value} »`}`;
      case 'select':     return `Choisir ${step.variable ? `la variable « ${step.variable} »` : `« ${step.value} »`} dans ${step.selector}`;
      case 'press':      return `Appuyer sur ${step.key} dans ${step.selector}`;
      case 'ai_task':    return `Tâche IA : ${step.objective}`;
      case 'loop_start': return `Début de boucle sur « ${step.variable} »`;
      case 'loop_end':   return 'Fin de boucle';
      default:           return step.action;
    }
  }

  variableEntries(vars: Record<string, string[]> | undefined): { name: string; values: string[] }[] {
    return Object.entries(vars ?? {}).map(([name, values]) => ({ name, values }));
  }
}
