import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    // eslint-plugin-react 7 detects the React version through `context.getFilename()`, which
    // ESLint 10 removed; an explicit version skips that code path.
    settings: { react: { version: '19.3' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
];
