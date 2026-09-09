import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { GqlAuthGuard } from '@jobber/graphql';

import { JobMetadata } from './models/job-metadata.model';
import { JobsService } from './jobs.service';
import { ExecuteJobInput } from './dto/execute-job.input';
import { Job } from './models/job.model';

@Resolver(() => JobMetadata)
export class JobsResolver {
  constructor(private jobService: JobsService) {}

  @Query(() => [JobMetadata], { name: 'jobsMetadata' })
  @UseGuards(GqlAuthGuard)
  async getJobsMetadata() {
    return this.jobService.getJobMetadata();
  }

  @Query(() => Job, { name: 'job' })
  @UseGuards(GqlAuthGuard)
  async getJob(@Args('id') id: number) {
    return this.jobService.getJob(id);
  }

  @Query(() => [Job], { name: 'jobs' })
  @UseGuards(GqlAuthGuard)
  async getJobs() {
    return this.jobService.getJobs();
  }

  @Mutation(() => Job)
  @UseGuards(GqlAuthGuard)
  async executeJob(@Args('executeJobInput') executeJobInput: ExecuteJobInput) {
    return this.jobService.executeJob(
      executeJobInput.name,
      executeJobInput.data,
    );
  }
}
