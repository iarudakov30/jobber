import { defineConfig } from 'vitest/config';

// Loaded by `@angular/build:unit-test` through `runnerConfig` in project.json.
export default defineConfig({
  test: {
    // Node 25+ defines its own global `localStorage`, which is `undefined` without
    // `--localstorage-file` and hides jsdom's. Turn it off in the test workers.
    execArgv: ['--no-webstorage'],
  },
});
