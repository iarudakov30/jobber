import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { TimeoutError, firstValueFrom, timeout } from 'rxjs';
import {
  AUTH_SERVICE_NAME,
  AuthServiceClient,
  GrpcStatus,
  Packages,
  User,
} from '@jobber/grpc';

/** How long the upgrade waits for auth before answering 503. */
export const AUTH_TIMEOUT_MS = 3_000;

/** The cookie isn't a valid session: 401. */
export class AuthRejectedError extends Error {
  override readonly name = 'AuthRejectedError';
}

/** Auth didn't answer: 503, so the client retries rather than sending the user to log in. */
export class AuthUnavailableError extends Error {
  override readonly name = 'AuthUnavailableError';
}

const UNAVAILABLE = new Set<number>([
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DEADLINE_EXCEEDED,
]);

/** Checks the `Authentication` cookie with auth's gRPC `Authenticate`, as `GqlAuthGuard` does. */
@Injectable()
export class SocketAuth implements OnModuleInit {
  private auth!: AuthServiceClient;

  constructor(@Inject(Packages.AUTH) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.auth = this.client.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
  }

  async authenticate(token: string): Promise<User> {
    try {
      return await firstValueFrom(
        this.auth.authenticate({ token }).pipe(timeout(AUTH_TIMEOUT_MS)),
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        error instanceof TimeoutError ||
        (typeof code === 'number' && UNAVAILABLE.has(code))
      ) {
        throw new AuthUnavailableError('auth is unavailable');
      }
      throw new AuthRejectedError('invalid session');
    }
  }
}

/** The value of cookie `name` in a `Cookie` header, or undefined. */
export function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value) || undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
