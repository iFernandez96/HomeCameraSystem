import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dev-dist',
      'node_modules',
      'coverage',
      '*.config.js',
      'src/sw.ts',
      // iter-356.36+: Node tooling scripts use Node globals (process,
      // console, document via Playwright) and aren't part of the
      // browser bundle. ESLint's browser-only config flags them as
      // no-undef false-positives.
      'tools/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      'react/prop-types': 'off',
      // We use explicit `unknown` casts for test mocks; allow when intentional.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Test files often have unused destructure params for fixture compat.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Test files: allow flexible mocking patterns.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    // Playwright e2e harnesses + node runner scripts (proof program,
    // 2026-07-08). These run under Node, and Playwright's fixture API
    // is a false positive for two browser-centric rules: fixtures are
    // `async ({}, use) => {...}` — the empty destructure is the
    // documented signature, and `use` is Playwright's fixture
    // callback, not a React hook.
    files: ['e2e/**/*.{ts,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty-pattern': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
)
