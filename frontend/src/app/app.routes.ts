import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ParametrageComponent } from './pages/parametrage/parametrage.component';
import { RobotsComponent } from './pages/robots/robots.component';
import { RecordComponent } from './pages/robots/record/record.component';
import { AssistantComponent } from './pages/robots/assistant/assistant.component';

export const routes: Routes = [
  { path: '',                       component: HomeComponent, pathMatch: 'full' },
  { path: 'robots',                 component: RobotsComponent },
  { path: 'robots/:id/enregistrer', component: RecordComponent },
  { path: 'robots/:id/assistant',   component: AssistantComponent },
  { path: 'parametrage',            component: ParametrageComponent },
  { path: '**',                     redirectTo: '' },
];
