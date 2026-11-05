import { gql } from 'apollo-angular';

import { Job, JobMetadata } from './job.model';

const JOB_FIELDS = gql`
  fragment JobFields on Job {
    id
    name
    size
    completed
    status
    started
    ended
  }
`;

export const JOBS_METADATA = gql<
  { jobsMetadata: JobMetadata[] },
  Record<string, never>
>`
  query JobsMetadata {
    jobsMetadata {
      name
      description
    }
  }
`;

export const JOBS = gql<{ jobs: Job[] }, Record<string, never>>`
  query Jobs {
    jobs {
      ...JobFields
    }
  }
  ${JOB_FIELDS}
`;

// `job(id)` is declared as a plain TS `number` in `JobsResolver`, which Nest maps to `Float`.
export const JOB = gql<{ job: Job }, { id: number }>`
  query Job($id: Float!) {
    job(id: $id) {
      ...JobFields
    }
  }
  ${JOB_FIELDS}
`;

export const EXECUTE_JOB = gql<
  { executeJob: Job },
  { executeJobInput: { name: string; data: unknown } }
>`
  mutation ExecuteJob($executeJobInput: ExecuteJobInput!) {
    executeJob(executeJobInput: $executeJobInput) {
      ...JobFields
    }
  }
  ${JOB_FIELDS}
`;
