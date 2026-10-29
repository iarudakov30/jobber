import { Component, input } from '@angular/core';
import { ReadonlyFieldTree } from '@angular/forms/signals';

/** Lists a signal-form field's errors once the user has interacted with it. */
@Component({
  selector: 'app-field-errors',
  template: `
    @let state = field()();
    @if (state.touched()) {
      @for (error of state.errors(); track $index) {
        <small class="hint error">{{ error.message }}</small>
      }
    }
  `,
  host: { class: 'field-errors' },
})
export class FieldErrors {
  readonly field = input.required<ReadonlyFieldTree<unknown>>();
}
