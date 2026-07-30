import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ApiService, AssistantProposal, LastRun, Robot, RobotStep, RunLogLine, StepActionSchema,
  StepFieldSchema,
} from '../../../core/api.service';
import { AssistantChatComponent } from '../assistant-chat/assistant-chat.component';

/** Une variable en cours d'édition — valeurs saisies une par ligne. */
interface VariableDraft {
  name: string;
  text: string;
}

/** Accès indexé aux champs d'une étape. Le vocabulaire vient du serveur, donc
 *  les noms de champs ne sont pas connus statiquement — la conversion est
 *  cantonnée ici plutôt que d'affaiblir le type `RobotStep`. */
type StepRecord = Record<string, unknown>;

/** Seul endroit où la conversion a lieu : `RobotStep` n'a pas de signature
 *  d'index (et ne doit pas en avoir — elle désactiverait tout contrôle de type
 *  sur les champs connus partout ailleurs). */
function fields(step: RobotStep): StepRecord {
  return step as unknown as StepRecord;
}

@Component({
  selector: 'app-edit',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, AssistantChatComponent],
  templateUrl: './edit.component.html',
  styleUrl: './edit.component.scss',
})
export class EditComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  robotId = Number(this.route.snapshot.paramMap.get('id'));

  robot = signal<Robot | null>(null);
  schema = signal<StepActionSchema[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  saving = signal(false);
  saved = signal(false);

  /** Brouillon : c'est lui qu'on édite. Rien ne part en base avant « Enregistrer ». */
  steps: RobotStep[] = [];
  variableDrafts: VariableDraft[] = [];
  /** Index de l'étape dépliée — une seule à la fois, la liste reste lisible. */
  openIndex = signal<number | null>(null);
  /** Le brouillon vient d'une proposition de l'assistant, pas encore enregistrée. */
  fromAssistant = signal(false);

  ngOnInit(): void {
    this.api.getStepSchema().subscribe({
      next: (payload) => this.schema.set(payload.actions),
      // Sans le vocabulaire, l'édition champ par champ est impossible, mais la
      // page reste utile (réordonner, supprimer, discuter avec l'assistant).
      error: () => this.error.set(
        "Le vocabulaire d'étapes n'a pas pu être chargé : l'édition détaillée est indisponible.",
      ),
    });

    this.api.getRobot(this.robotId).subscribe({
      next: (robot) => { this.load(robot); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.error.set('Impossible de charger ce robot.');
      },
    });
  }

  private load(robot: Robot): void {
    this.robot.set(robot);
    // Copie profonde : éditer le brouillon ne doit pas modifier la référence
    // servant à détecter les changements non enregistrés.
    this.steps = JSON.parse(JSON.stringify(robot.steps ?? []));
    this.variableDrafts = this.buildVariableDrafts(robot.variables ?? {}, this.steps);
    this.fromAssistant.set(false);
    this.openIndex.set(null);
  }

  /** Toute variable sur laquelle une boucle porte doit être éditable, même sans
   *  aucune valeur — c'est précisément le cas qui rendait la boucle inerte. */
  private buildVariableDrafts(
    variables: Record<string, string[]>, steps: RobotStep[],
  ): VariableDraft[] {
    const names = new Set<string>();
    for (const step of steps) {
      if (step.action === 'loop_start' && step.variable) names.add(step.variable);
    }
    for (const name of Object.keys(variables)) names.add(name);

    return [...names].map((name) => ({
      name,
      text: (variables[name] ?? []).join('\n'),
    }));
  }

  private currentVariables(): Record<string, string[]> {
    const variables: Record<string, string[]> = {};
    for (const draft of this.variableDrafts) {
      // Une ligne = une valeur ; les lignes vides ne sont pas des valeurs.
      variables[draft.name] = draft.text
        .split('\n')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }
    return variables;
  }

  dirty(): boolean {
    const robot = this.robot();
    if (!robot) return false;
    return JSON.stringify(this.steps) !== JSON.stringify(robot.steps ?? [])
      || JSON.stringify(this.currentVariables()) !== JSON.stringify(robot.variables ?? {});
  }

  save(): void {
    this.saving.set(true);
    this.error.set(null);
    this.saved.set(false);

    this.api.updateRobotSteps(this.robotId, this.steps, this.currentVariables()).subscribe({
      next: (robot) => {
        this.load(robot);
        this.saving.set(false);
        this.saved.set(true);
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(
          err?.error?.steps?.[0]
          ?? err?.error?.variables?.[0]
          ?? "Le parcours n'a pas pu être enregistré.",
        );
      },
    });
  }

  revert(): void {
    const robot = this.robot();
    if (robot) this.load(robot);
  }

  /** Charge une proposition de l'assistant dans le brouillon — sans enregistrer :
   *  la personne la relit dans l'éditeur puis décide. */
  onAssistantProposal(proposal: AssistantProposal): void {
    this.steps = JSON.parse(JSON.stringify(proposal.steps));
    this.variableDrafts = this.buildVariableDrafts(proposal.variables ?? {}, this.steps);
    this.fromAssistant.set(true);
    this.saved.set(false);
    this.openIndex.set(null);
  }

  // ── Manipulation des étapes ────────────────────────────────────────────

  toggle(index: number): void {
    this.openIndex.update((open) => (open === index ? null : index));
  }

  move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.steps.length) return;
    const steps = [...this.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    this.steps = steps;
    this.openIndex.set(null);
    this.saved.set(false);
  }

  remove(index: number): void {
    this.steps = this.steps.filter((_, i) => i !== index);
    this.variableDrafts = this.buildVariableDrafts(this.currentVariables(), this.steps);
    this.openIndex.set(null);
    this.saved.set(false);
  }

  addable(): StepActionSchema[] {
    return this.schema().filter((action) => action.addable);
  }

  add(action: string): void {
    if (!action) return;
    this.steps = [...this.steps, { action }];
    this.openIndex.set(this.steps.length - 1);
    this.saved.set(false);
  }

  /** Variables déclarées par les boucles, proposées à la saisie sur les étapes
   *  `fill`/`select` — évite de retaper un nom et de se tromper. */
  loopVariables(): string[] {
    return [...new Set(
      this.steps
        .filter((step) => step.action === 'loop_start' && step.variable)
        .map((step) => step.variable as string),
    )];
  }

  // ── Champs d'une étape, d'après le vocabulaire servi par le backend ────

  fieldsFor(step: RobotStep): StepFieldSchema[] {
    return this.schema().find((a) => a.action === step.action)?.fields ?? [];
  }

  actionLabel(action: string): string {
    return this.schema().find((a) => a.action === action)?.label ?? action;
  }

  text(step: RobotStep, name: string): string {
    const value = fields(step)[name];
    return value === undefined || value === null ? '' : String(value);
  }

  list(step: RobotStep, name: string): string {
    const value = fields(step)[name];
    return Array.isArray(value) ? value.join('\n') : '';
  }

  bool(step: RobotStep, name: string): boolean {
    return fields(step)[name] === true;
  }

  setText(step: RobotStep, field: StepFieldSchema, raw: string): void {
    const record = fields(step);
    if (raw === '') {
      // Un champ vidé est retiré, pas mis à '' : le validateur refuse les champs
      // non reconnus mais aussi, pour certains, une valeur du mauvais type.
      delete record[field.name];
    } else {
      record[field.name] = field.type === 'number' ? Number(raw) : raw;
    }
    this.saved.set(false);
  }

  setList(step: RobotStep, field: StepFieldSchema, raw: string): void {
    const values = raw.split('\n').map((v) => v.trim()).filter((v) => v.length > 0);
    const record = fields(step);
    if (values.length === 0) delete record[field.name];
    else record[field.name] = values;
    this.saved.set(false);
  }

  setBool(step: RobotStep, field: StepFieldSchema, value: boolean): void {
    fields(step)[field.name] = value;
    this.saved.set(false);
  }

  /** Le point d'impact n'est pas saisissable : il vient de l'enregistrement.
   *  Affiché pour information, supprimable si la personne veut le clic au centre. */
  positionOf(step: RobotStep): string | null {
    const p = step.position;
    if (!p) return null;
    return `x ${Math.round(p.x)} · y ${Math.round(p.y)}`
      + (p.w && p.h ? ` (dans ${Math.round(p.w)} × ${Math.round(p.h)})` : '');
  }

  clearPosition(step: RobotStep): void {
    delete fields(step)['position'];
    this.saved.set(false);
  }

  /** Profondeur de boucle, pour indenter le corps et rendre la structure visible. */
  depthOf(index: number): number {
    let depth = 0;
    for (let i = 0; i < index; i++) {
      if (this.steps[i].action === 'loop_start') depth++;
      else if (this.steps[i].action === 'loop_end') depth--;
    }
    if (this.steps[index]?.action === 'loop_end') depth--;
    return Math.max(0, depth);
  }

  /** Résumé lisible d'une étape — la personne ne doit pas avoir à lire du JSON. */
  describe(step: RobotStep): string {
    switch (step.action) {
      case 'goto':       return `Ouvrir ${step.url}`;
      case 'click':      return `Cliquer ${step.text ? `« ${step.text} »` : step.selector}`;
      case 'fill':       return step.masked
        ? `Remplir ${step.selector} (mot de passe, non enregistré)`
        : `Remplir ${step.selector} avec ${step.variable ? `la variable « ${step.variable} »` : `« ${step.value} »`}`;
      case 'select':     return `Choisir ${step.variable ? `la variable « ${step.variable} »` : `« ${step.value} »`} dans ${step.selector}`;
      case 'press':      return `Appuyer sur ${step.key} dans ${step.selector}`;
      case 'scroll':     return `Faire défiler jusqu'à ${step.y ?? 0} px`;
      case 'dialog':     return `Boîte « ${step.message ?? ''} » : ${step.accept ? 'Accepter' : 'Refuser'}`;
      case 'ai_task':    return `Tâche IA : ${step.objective}`
        + (step.save_as ? ` (mémorisé sous « ${step.save_as} »)` : '');
      case 'loop_start': return `Début de boucle sur « ${step.variable} »`;
      case 'loop_end':   return 'Fin de boucle';
      default:           return step.action;
    }
  }

  /** Première ligne de l'étape : le libellé enregistré est souvent multi-ligne
   *  (le texte entier d'une liste déroulante, par exemple). */
  summary(step: RobotStep): string {
    return this.describe(step).split('\n')[0].slice(0, 110);
  }

  valueCount(draft: VariableDraft): number {
    return draft.text.split('\n').filter((value) => value.trim().length > 0).length;
  }

  failedLines(run: LastRun): RunLogLine[] {
    return run.log.filter((line) => line.state === 'failed');
  }
}
