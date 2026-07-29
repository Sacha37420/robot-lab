import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService, Robot, RobotInput } from '../../core/api.service';

const EMPTY_FORM: RobotInput = { name: '', description: '', start_url: '' };

@Component({
  selector: 'app-robots',
  standalone: true,
  imports: [FormsModule, DatePipe, RouterLink],
  templateUrl: './robots.component.html',
  styleUrl: './robots.component.scss',
})
export class RobotsComponent implements OnInit {
  private api = inject(ApiService);

  robots = signal<Robot[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  formOpen = signal(false);
  editingId = signal<number | null>(null);
  // Brouillon du formulaire : objet muté directement par [(ngModel)], pas un
  // signal — un signal exigerait un setter par champ pour l'édition en place.
  form: RobotInput = { ...EMPTY_FORM };
  saving = signal(false);
  formError = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.getRobots().subscribe({
      next: (robots) => { this.robots.set(robots); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.error.set('Impossible de charger les robots.');
      },
    });
  }

  openCreate(): void {
    this.editingId.set(null);
    this.form = { ...EMPTY_FORM };
    this.formError.set(null);
    this.formOpen.set(true);
  }

  openEdit(robot: Robot): void {
    this.editingId.set(robot.id);
    this.form = { name: robot.name, description: robot.description, start_url: robot.start_url };
    this.formError.set(null);
    this.formOpen.set(true);
  }

  cancelForm(): void {
    this.formOpen.set(false);
  }

  submitForm(): void {
    const payload = this.form;
    if (!payload.name.trim() || !payload.start_url.trim()) {
      this.formError.set("Le nom et l'URL de départ sont obligatoires.");
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    const id = this.editingId();
    const request$ = id === null
      ? this.api.createRobot(payload)
      : this.api.updateRobot(id, payload);

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.formError.set("Échec de l'enregistrement du robot.");
      },
    });
  }

  remove(robot: Robot): void {
    if (!confirm(`Supprimer le robot « ${robot.name} » ?`)) return;
    this.api.deleteRobot(robot.id).subscribe({
      next: () => this.load(),
      error: () => this.error.set('Impossible de supprimer ce robot.'),
    });
  }
}
