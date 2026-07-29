import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ParametrageComponent } from './pages/parametrage/parametrage.component';
import { RobotsComponent } from './pages/robots/robots.component';

export const routes: Routes = [
  { path: '',            component: HomeComponent, pathMatch: 'full' },
  { path: 'robots',      component: RobotsComponent },
  { path: 'parametrage', component: ParametrageComponent },
  { path: '**',          redirectTo: '' },
];
