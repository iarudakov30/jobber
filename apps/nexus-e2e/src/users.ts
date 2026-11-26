/** The users global setup creates for one run (passed to the tests through the environment). */
export interface E2eUser {
  id: number;
  email: string;
  password: string;
}

export interface E2eUsers {
  /** Starts with $100.00. */
  sender: E2eUser;
  /** Starts with $0.00. */
  recipient: E2eUser;
  /** Starts with $100.00, for the market tests. */
  trader: E2eUser;
  /** True when this run started the realtime gateway (and so may kill it). */
  ownsGateway: boolean;
}

export const USERS_ENV = 'NEXUS_E2E_USERS';

export function e2eUsers(): E2eUsers {
  const users = process.env[USERS_ENV];
  if (!users) {
    throw new Error(
      `${USERS_ENV} is not set: run through playwright (global setup)`,
    );
  }
  return JSON.parse(users);
}
