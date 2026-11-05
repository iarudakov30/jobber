import { Route } from '@angular/router';

import { authGuard } from './auth/auth.guard';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'jobs' },
  {
    path: 'login',
    title: 'Sign in · Jobber',
    loadComponent: () => import('./auth/login/login').then((m) => m.Login),
  },
  {
    path: 'register',
    title: 'Create account · Jobber',
    loadComponent: () =>
      import('./auth/register/register').then((m) => m.Register),
  },
  {
    path: 'jobs',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        title: 'Jobs · Jobber',
        loadComponent: () =>
          import('./jobs/jobs-list/jobs-list').then((m) => m.JobsList),
      },
      {
        path: ':id',
        title: 'Job · Jobber',
        loadComponent: () =>
          import('./jobs/job-detail/job-detail').then((m) => m.JobDetail),
      },
    ],
  },
  { path: '**', redirectTo: 'jobs' },
];
