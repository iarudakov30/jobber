import { ClientGrpc } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { AuditResult } from '@jobber/grpc';
import { LedgerAuditMessage, PulsarClient } from '@jobber/pulsar';
import { LedgerAuditConsumer } from './ledger-audit.consumer';

describe('LedgerAuditConsumer', () => {
  function consumer(runAudit: () => Observable<AuditResult>) {
    const wallet = { runAudit: jest.fn(runAudit) };
    const instance = new LedgerAuditConsumer(
      {} as PulsarClient,
      {} as ClientGrpc,
      { getService: () => wallet } as unknown as ClientGrpc,
    );
    // Only the wallet client: onModuleInit would also subscribe to Pulsar.
    Object.assign(instance, { walletService: wallet });
    const logger = (instance as unknown as { logger: object }).logger;
    return {
      execute: (data: Partial<LedgerAuditMessage>) =>
        (
          instance as unknown as {
            execute(d: Partial<LedgerAuditMessage>): Promise<void>;
          }
        ).execute({ jobId: 3, index: 0, ...data }),
      wallet,
      log: jest.spyOn(logger as never, 'log').mockImplementation(),
      error: jest.spyOn(logger as never, 'error').mockImplementation(),
    };
  }

  it('reports sound books in one line', async () => {
    // An empty repeated field may arrive as undefined from proto-loader.
    const { execute, wallet, log, error } = consumer(() =>
      of({} as AuditResult),
    );

    await execute({ trigger: 'schedule' });

    expect(wallet.runAudit).toHaveBeenCalledWith({});
    expect(log).toHaveBeenCalledWith(
      'Ledger audit (job 3, schedule): no issues',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('logs every issue as an error, without failing the job', async () => {
    const { execute, error } = consumer(() =>
      of({
        issues: [
          {
            kind: 'balance_drift',
            detail:
              'account 12 (user 3 USD available): balance 501, entries sum to 500',
          },
        ],
      }),
    );

    await expect(execute({})).resolves.toBeUndefined();

    expect(error.mock.calls).toEqual([
      ['Ledger audit (job 3, manual): 1 issue(s)'],
      [
        'Ledger audit (job 3, manual): balance_drift: account 12 (user 3 USD available): balance 501, entries sum to 500',
      ],
    ]);
  });

  it('fails (so Pulsar redelivers) when the wallet is unreachable', async () => {
    const { execute } = consumer(() =>
      throwError(() => new Error('14 UNAVAILABLE: No connection established')),
    );

    await expect(execute({})).rejects.toThrow('UNAVAILABLE');
  });
});
