import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['**/dist/**', '**/coverage/**', '**/src-tauri/target/**', '.remember/**'] }, ...tseslint.configs.recommended, {
  rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
});
