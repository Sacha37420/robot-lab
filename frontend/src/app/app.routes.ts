import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ParametrageComponent } from './pages/parametrage/parametrage.component';
import { RobotsComponent } from './pages/robots/robots.component';
import { RecordComponent } from './pages/robots/record/record.component';
import { EditComponent } from './pages/robots/edit/edit.component';
import { RunComponent } from './pages/robots/run/run.component';

export const routes: Routes = [
  { path: '',                       component: HomeComponent, pathMatch: 'full' },
  { path: 'robots',                 component: RobotsComponent },
  { path: 'robots/:id/enregistrer', component: RecordComponent },
  { path: 'robots/:id/modifier',    component: EditComponent },
  // Ancienne adresse de la page assistant, devenue l'éditeur : les liens
  // déjà en circulation (favoris) doivent continuer de fonctionner.
  { path: 'robots/:id/assistant',   redirectTo: 'robots/:id/modifier' },
  { path: 'robots/:id/lancer',      component: RunComponent },
  { path: 'parametrage',            component: ParametrageComponent },
  { path: '**',                     redirectTo: '' },
];
