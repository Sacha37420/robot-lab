import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ParametrageComponent } from './pages/parametrage/parametrage.component';
import { RobotsComponent } from './pages/robots/robots.component';
import { RecordComponent } from './pages/robots/record/record.component';
import { AssistantComponent } from './pages/robots/assistant/assistant.component';
import { RunComponent } from './pages/robots/run/run.component';

export const routes: Routes = [
  { path: '',                       component: HomeComponent, pathMatch: 'full' },
  { path: 'robots',                 component: RobotsComponent },
  { path: 'robots/:id/enregistrer', component: RecordComponent },
  { path: 'robots/:id/assistant',   component: AssistantComponent },
  { path: 'robots/:id/lancer',      component: RunComponent },
  { path: 'parametrage',            component: ParametrageComponent },
  { path: '**',                     redirectTo: '' },
];
