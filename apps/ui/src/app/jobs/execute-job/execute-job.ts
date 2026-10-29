import {
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  required,
  validate,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { serverErrors } from '../../shared/error-message';
import { FieldErrors } from '../../shared/field-errors';
import { signalFormsConfig } from '../../shared/signal-forms';
import { Job } from '../job.model';
import { JobsService } from '../jobs.service';

/** Example payloads prefilled per job type (names match the `Jobs` enum in `@jobber/nestjs`). */
const SAMPLE_DATA: Record<string, unknown> = {
  Fibonacci: { iterations: 10 },
  LoadProducts: [
    {
      name: 'Widget',
      category: 'Electronics',
      price: 29.99,
      stock: 100,
      rating: 4.5,
      description: 'A cool widget',
    },
    {
      name: 'Gadget',
      category: 'Tools',
      price: 49.99,
      stock: 50,
      rating: 3.8,
      description: 'A handy gadget',
    },
  ],
};

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-execute-job',
  imports: [FormField, FormRoot, RouterLink, FieldErrors],
  templateUrl: './execute-job.html',
  providers: [signalFormsConfig],
})
export class ExecuteJob {
  private readonly jobsService = inject(JobsService);

  protected readonly metadata = rxResource({
    stream: () => this.jobsService.metadata(),
  });

  /** Defaults to the first job type once metadata loads; the user can then pick another. */
  private readonly jobName = linkedSignal(() =>
    this.metadata.hasValue() ? (this.metadata.value()[0]?.name ?? '') : '',
  );

  /** Resets to the sample payload whenever the job type changes, but stays editable. */
  private readonly payload = linkedSignal({
    source: this.jobName,
    computation: (name) => JSON.stringify(SAMPLE_DATA[name] ?? {}, null, 2),
  });

  /** The job started by the last successful submit. */
  protected readonly started = signal<Job | null>(null);

  protected readonly jobType = form(this.jobName);

  protected readonly payloadForm = form(
    this.payload,
    (payload) => {
      required(payload, { message: 'Data is required.' });
      validate(payload, ({ value }) =>
        isJson(value())
          ? undefined
          : { kind: 'json', message: 'Enter valid JSON.' },
      );
    },
    {
      submission: {
        action: async (payloadForm) => {
          this.started.set(null);
          try {
            this.started.set(
              await firstValueFrom(
                this.jobsService.execute(
                  this.jobName(),
                  JSON.parse(payloadForm().value()),
                ),
              ),
            );
          } catch (err) {
            return serverErrors(err);
          }
          return undefined;
        },
      },
    },
  );

  protected readonly description = computed(
    () =>
      this.metadata.hasValue() &&
      this.metadata.value().find((m) => m.name === this.jobName())?.description,
  );
}
