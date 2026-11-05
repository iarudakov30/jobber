import { Component, inject, input, signal } from '@angular/core';
import {
  FormField,
  FormRoot,
  email,
  form,
  required,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { serverErrors } from '../../shared/error-message';
import { FieldErrors } from '../../shared/field-errors';
import { FormErrors } from '../../shared/form-errors';
import { signalFormsConfig } from '../../shared/signal-forms';
import { AuthService } from '../auth.service';
import { Credentials } from '../user.model';

@Component({
  selector: 'app-login',
  imports: [FormField, FormRoot, RouterLink, FieldErrors, FormErrors],
  templateUrl: './login.html',
  providers: [signalFormsConfig],
})
export class Login {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  /** Bound from the `?returnUrl=` query param set by `authGuard`. */
  readonly returnUrl = input<string>();

  protected readonly loginForm = form(
    signal<Credentials>({ email: '', password: '' }),
    (credentials) => {
      required(credentials.email, { message: 'Email is required.' });
      email(credentials.email, { message: 'Enter a valid email address.' });
      required(credentials.password, { message: 'Password is required.' });
    },
    {
      submission: {
        action: async (loginForm) => {
          try {
            await firstValueFrom(this.authService.login(loginForm().value()));
          } catch (err) {
            return serverErrors(err);
          }
          await this.router.navigateByUrl(this.returnUrl() || '/jobs');
          return undefined;
        },
      },
    },
  );
}
