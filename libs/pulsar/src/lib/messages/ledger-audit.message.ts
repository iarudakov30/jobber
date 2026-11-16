import { IsIn, IsOptional } from 'class-validator';
import { JobMessage } from './job.message';

export const LEDGER_AUDIT_TRIGGERS = ['schedule', 'manual'] as const;

/**
 * Asks the executor to run the wallet's ledger audit (`WalletService.RunAudit`). The audit only
 * reads, so a redelivered message is harmless.
 */
export class LedgerAuditMessage extends JobMessage {
  /** Who started it: the nightly schedule in `jobs`, or a person through `executeJob`. */
  @IsOptional()
  @IsIn(LEDGER_AUDIT_TRIGGERS)
  trigger?: (typeof LEDGER_AUDIT_TRIGGERS)[number];
}
