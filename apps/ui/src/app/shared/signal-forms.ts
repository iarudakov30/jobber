import { provideSignalFormsConfig } from '@angular/forms/signals';

/**
 * Signal forms don't add `ng-touched`/`ng-invalid`; flag touched, invalid controls ourselves.
 *
 * Provided per form component rather than in `app.config.ts` so `@angular/forms/signals` stays
 * in the lazy route chunks instead of the initial bundle.
 */
export const signalFormsConfig = provideSignalFormsConfig({
  classes: {
    'is-invalid': ({ state }) => state().touched() && state().invalid(),
  },
});
