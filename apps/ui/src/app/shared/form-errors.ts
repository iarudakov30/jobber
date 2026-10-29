import { Component, input } from '@angular/core';
import { ReadonlyFieldTree } from '@angular/forms/signals';

/** Shows errors attached to the form itself, e.g. a server error not tied to one field. */
@Component({
  selector: 'app-form-errors',
  template: `
    @for (error of form()().errors(); track $index) {
      <p class="alert" role="alert">{{ error.message }}</p>
    }
  `,
  host: { class: 'form-errors' },
})
export class FormErrors {
  readonly form = input.required<ReadonlyFieldTree<unknown>>();
}
