import { IsInt, Max, Min } from 'class-validator';
import { JobMessage } from './job.message';

/**
 * The executor computes Fibonacci synchronously with big integers, so the cost grows much faster
 * than linearly and blocks its event loop, stalling every other consumer in the process. Measured
 * with the `fibonacci` package: 1,000 iterations take ~30 ms, 10,000 take ~9 s, and 1,000,000
 * never finished.
 */
export const MAX_FIBONACCI_ITERATIONS = 1_000;

export class FibonacciMessage extends JobMessage {
  @IsInt()
  @Min(1)
  @Max(MAX_FIBONACCI_ITERATIONS)
  iterations: number;
}
