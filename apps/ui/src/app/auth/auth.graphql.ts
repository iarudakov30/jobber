import { gql } from 'apollo-angular';

import { Credentials, User } from './user.model';

export const LOGIN = gql<{ login: User }, { loginInput: Credentials }>`
  mutation Login($loginInput: LoginInput!) {
    login(loginInput: $loginInput) {
      id
      email
    }
  }
`;

export const CREATE_USER = gql<
  { createUser: User },
  { createUserInput: Credentials }
>`
  mutation CreateUser($createUserInput: CreateUserInput!) {
    createUser(createUserInput: $createUserInput) {
      id
      email
    }
  }
`;
