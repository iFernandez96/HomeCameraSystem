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
    // React rule surface: the app source ONLY. e2e harnesses and node
    // scripts are not React code — scoping here (rather than carving
    // exceptions out of a repo-wide block) is the conventional flat-
    // config shape and means Playwright's fixture API (`use`, empty-
    // pattern destructures) never meets the react-hooks plugin at all.
    files: ['src/**/*.{ts,tsx}'],
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
    // 2026-07-08). Node environment; browser globals appear inside
    // page.evaluate() strings the harnesses build. React plugins are
    // deliberately NOT applied here (see the src/** scope above) —
    // Playwright fixtures (`async ({}, use) => {}`) are the documented
    // API, and `no-empty-pattern` is the one core rule it collides
    // with.
    files: ['e2e/**/*.{ts,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
