import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'examples/cap-app/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['tests/**/*.cjs', 'scripts/**/*.cjs', 'cds-plugin.js', 'examples/provider-package/**/*.js'],
    languageOptions: { globals: { require: 'readonly', module: 'readonly', __dirname: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
];
