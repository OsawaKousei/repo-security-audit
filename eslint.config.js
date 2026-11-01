import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.playwright/**', '.local/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['infra/terraform/modules/frontend/*.js'],
    languageOptions: { sourceType: 'script' },
    // CloudFront invokes a global handler rather than an ES module export.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^handler$' }] },
  },
  { languageOptions: { globals: { ...globals.node, ...globals.browser }, parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { files: ['frontend/app/src/**/*.{ts,tsx}'], plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules, ...reactRefresh.configs.vite.rules } },
]
