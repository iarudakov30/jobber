export type JobStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface Job {
  id: string;
  name: string;
  size: number;
  completed: number;
  status: JobStatus;
  started: string;
  ended: string | null;
  /** The job's OpenTelemetry trace in Jaeger; null when tracing was off. */
  traceId: string | null;
}

export interface JobMetadata {
  name: string;
  description: string;
}
