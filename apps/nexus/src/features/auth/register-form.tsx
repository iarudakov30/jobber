import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { applyServerErrors } from '../../lib/errors';
import { login, register as registerUser } from './auth-api';

// Full strength rules are enforced server-side by `@IsStrongPassword()` on `CreateUserInput`;
// its messages ("password is not strong enough") are mapped back onto the matching field.
const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .pipe(z.email('Enter a valid email address.')),
  password: z.string().min(8, 'Use at least 8 characters.'),
});

type RegisterValues = z.infer<typeof registerSchema>;

export function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '' },
  });
  const { mutateAsync } = useMutation({
    mutationFn: async (credentials: RegisterValues) => {
      await registerUser(credentials);
      await login(credentials);
    },
  });

  const onSubmit = handleSubmit(async (credentials) => {
    try {
      await mutateAsync(credentials);
    } catch (err) {
      applyServerErrors(err, setError, ['email', 'password']);
      return;
    }
    onSuccess();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field id="email" label="Email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
      </Field>
      <Field id="password" label="Password" error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.password}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
      </Field>
      <FormError message={errors.root?.server?.message} />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
