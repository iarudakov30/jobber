import { killGateway } from './gateway';

/** Stops the realtime gateway global setup started (if it started one). */
export default async function globalTeardown(): Promise<void> {
  killGateway();
}
