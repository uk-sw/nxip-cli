// typescript-eslint's type-aware rules, so that the rules AGENTS.md states in
// prose ("no unexplained any", "delete what you make dead", every promise
// handled) are checked by a tool rather than by a reader. The type-aware
// set needs the project's types; tsconfig.eslint.json widens the build
// tsconfig to the tests so they are linted too.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    rules: {
      // Unused imports and locals are dead code; an underscore prefix is the
      // one accepted way to say "intentionally unused".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // A promise nobody awaits or handles is a lost error.
      '@typescript-eslint/no-floating-promises': 'error',
      // A warning with the baseline recorded (2 on 2026-10-13) so the count
      // in CI output can only go down; the no-unsafe-* family stays off
      // until it is zero. New code gets no any without a comment saying
      // why no type fits (AGENTS.md). Same tiering as the API.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Test files build fetch mocks that stringify whatever body they were
    // handed and pass async callbacks where the mocked API expects a sync
    // one; both are the point of the mock, not a defect. The rules that
    // catch dead code and lost promises stay on for tests too.
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
);
