import { context, propagation } from '@opentelemetry/api';

import { NewOutboxRecord } from './outbox.types';

/** Adds the active trace context to each record's headers (the record's own headers win). */
export function withTraceHeaders(
  records: NewOutboxRecord[],
): NewOutboxRecord[] {
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  return records.map((r) => ({ ...r, headers: { ...trace, ...r.headers } }));
}
