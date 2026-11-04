import { authClient } from '../../lib/graphql';
import { session, type User } from '../../lib/session';

export interface Credentials {
  email: string;
  password: string;
}

const LOGIN = /* GraphQL */ `
  mutation Login($loginInput: LoginInput!) {
    login(loginInput: $loginInput) {
      id
      email
    }
  }
`;

const CREATE_USER = /* GraphQL */ `
  mutation CreateUser($createUserInput: CreateUserInput!) {
    createUser(createUserInput: $createUserInput) {
      id
      email
    }
  }
`;

/** Logs in; the `auth` service sets the HttpOnly `Authentication` cookie on the response. */
export async function login(credentials: Credentials): Promise<User> {
  const { login: user } = await authClient.request<{ login: User }>(LOGIN, {
    loginInput: credentials,
  });
  session.set(user);
  return user;
}

export async function register(credentials: Credentials): Promise<User> {
  const { createUser } = await authClient.request<{ createUser: User }>(
    CREATE_USER,
    { createUserInput: credentials },
  );
  return createUser;
}
