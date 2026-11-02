export class JobMessage {
  jobId: number;
  /** The item's position in its job, set by `jobs`; acknowledgements are counted once per index. */
  index: number;
}
