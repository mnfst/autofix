import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // An empty catch is how this codebase falls open. It stays legal, but
      // only with a comment naming the failure being swallowed.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // The size limits from CONTRIBUTING, enforced rather than remembered.
    // Only src: a test file grows by covering more cases, and splitting one to
    // satisfy a counter helps nobody. Examples and scripts print freely.
    files: ['src/**/*.ts'],
    rules: {
      'max-lines': ['error', 300],
      'max-lines-per-function': ['error', 50],
      'max-depth': ['error', 3],
      complexity: ['error', 12],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
);
