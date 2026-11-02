import {
  AcknowledgeRequest,
  JOBS_SERVICE_NAME,
  JobsServiceClient,
} from '@jobber/grpc';
import { MessageMeta, PulsarClient, PulsarConsumer } from '@jobber/pulsar';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

export abstract class JobsConsumer<
  T extends AcknowledgeRequest,
> extends PulsarConsumer<T> {
  private jobsService: JobsServiceClient;

  constructor(
    topic: string,
    pulsarClient: PulsarClient,
    private readonly grpcClient: ClientGrpc,
  ) {
    super(pulsarClient, topic);
  }

  async onModuleInit(): Promise<void> {
    this.jobsService =
      this.grpcClient.getService<JobsServiceClient>(JOBS_SERVICE_NAME);
    await super.onModuleInit();
  }

  protected async onMessage(data: T, meta: MessageMeta): Promise<void> {
    await this.execute(data, meta);
    injectAckFault();
    await firstValueFrom(
      this.jobsService.acknowledge({ jobId: data.jobId, index: data.index }),
    );
  }

  protected abstract execute(data: T, meta: MessageMeta): Promise<void>;
}

/**
 * Test hook: with `FAULT_ACK_FAILURES=n` (never in production), the first n messages fail after
 * `execute` has done its work, so Pulsar redelivers them. That proves redeliveries are harmless:
 * the job still counts each item once and `execute` must not repeat its side effects.
 */
let ackFaultsLeft =
  process.env['NODE_ENV'] === 'production'
    ? 0
    : Number(process.env['FAULT_ACK_FAILURES'] ?? 0);

function injectAckFault() {
  if (ackFaultsLeft > 0) {
    ackFaultsLeft--;
    throw new Error(
      `Injected fault after execute (FAULT_ACK_FAILURES, ${ackFaultsLeft} left)`,
    );
  }
}
