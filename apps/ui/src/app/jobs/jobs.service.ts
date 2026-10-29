import { Injectable, inject } from '@angular/core';
import { ObservableQuery } from '@apollo/client';
import { Apollo } from 'apollo-angular';
import { Observable, OperatorFunction, filter, map, pipe, tap } from 'rxjs';

import { requireData } from '../shared/require-data';
import { Job, JobMetadata } from './job.model';
import { EXECUTE_JOB, JOB, JOBS, JOBS_METADATA } from './jobs.graphql';

/** How often in-flight job progress is refreshed. */
const POLL_INTERVAL_MS = 2000;

/**
 * Data access for the `jobs` GraphQL API. Queries return plain data streams (consumed by
 * components via `rxResource`): they emit each complete result, and error on a GraphQL or
 * network error, which ends the watch until the resource is reloaded.
 */
@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly apollo = inject(Apollo);

  metadata(): Observable<JobMetadata[]> {
    return this.apollo.watchQuery({ query: JOBS_METADATA }).valueChanges.pipe(
      completeData(),
      map(({ jobsMetadata }) => jobsMetadata),
    );
  }

  jobs(): Observable<Job[]> {
    return this.apollo
      .watchQuery({
        query: JOBS,
        fetchPolicy: 'cache-and-network',
        pollInterval: POLL_INTERVAL_MS,
      })
      .valueChanges.pipe(
        completeData(),
        map(({ jobs }) => jobs),
      );
  }

  /** Watches one job, polling until it leaves `IN_PROGRESS`. */
  job(id: number): Observable<Job> {
    const queryRef = this.apollo.watchQuery({
      query: JOB,
      variables: { id },
      fetchPolicy: 'cache-and-network',
      pollInterval: POLL_INTERVAL_MS,
    });
    return queryRef.valueChanges.pipe(
      completeData(),
      map(({ job }) => job),
      tap((job) => {
        if (job.status !== 'IN_PROGRESS') {
          queryRef.stopPolling();
        }
      }),
    );
  }

  execute(name: string, data: unknown): Observable<Job> {
    return this.apollo
      .mutate({
        mutation: EXECUTE_JOB,
        variables: { executeJobInput: { name, data } },
        refetchQueries: [JOBS],
      })
      .pipe(
        requireData(),
        map(({ executeJob }) => executeJob),
      );
  }
}

/** Skips loading/partial results and rethrows a result's error so the resource sees it. */
function completeData<T>(): OperatorFunction<ObservableQuery.Result<T>, T> {
  return pipe(
    filter((result) => !!result.error || result.dataState === 'complete'),
    map((result) => {
      if (result.error) {
        throw result.error;
      }
      return result.data as T;
    }),
  );
}
