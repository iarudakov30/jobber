import { JobMetadata } from '../interfaces/job-metadata.interface';
import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';

export const JOB_METADATA_KEY = 'job-metadata';

export const Job = (meta: JobMetadata) => {
  return applyDecorators(SetMetadata(JOB_METADATA_KEY, meta), Injectable());
};
