import { PulsarClient } from '@jobber/pulsar';
import { FIBONACCI_TOPIC, FibonacciData } from '@jobber/jobs-lib';
import { Job } from '../../decorators/job.decorator';
import { AbstractJob } from '../abstract.job';

@Job({
  name: FIBONACCI_TOPIC,
  description: 'Generate a Fibonacci sequence and store it in the DB.',
})
export class FibonacciJob extends AbstractJob<FibonacciData> {
  protected messageClass = FibonacciData;
  constructor(pulsarClient: PulsarClient) {
    super(pulsarClient);
  }
}
