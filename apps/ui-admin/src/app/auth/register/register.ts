import { Component, inject, signal } from '@angular/core';
import {
  FormField,
  FormRoot,
  email,
  form,
  minLength,
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
  selector: 'app-register',
  imports: [FormField, FormRoot, RouterLink, FieldErrors, FormErrors],
  templateUrl: './register.html',
  providers: [signalFormsConfig],
})
export class Register {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  // Full strength rules are enforced server-side by `@IsStrongPassword()` on `CreateUserInput`;
  // its messages ("password is not strong enough") are mapped back onto the matching field.
  protected readonly registerForm = form(
    signal<Credentials>({ email: '', password: '' }),
    (credentials) => {
      required(credentials.email, { message: 'Email is required.' });
      email(credentials.email, { message: 'Enter a valid email address.' });
      required(credentials.password, { message: 'Password is required.' });
      minLength(credentials.password, 8, {
        message: 'Use at least 8 characters.',
      });
    },
    {
      submission: {
        action: async (registerForm) => {
          const credentials = registerForm().value();
          try {
            await firstValueFrom(this.authService.register(credentials));
            await firstValueFrom(this.authService.login(credentials));
          } catch (err) {
            return serverErrors(err, {
              email: registerForm.email,
              password: registerForm.password,
            });
          }
          await this.router.navigateByUrl('/jobs');
          return undefined;
        },
      },
    },
  );
}
