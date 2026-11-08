// Lint pre TypeScript (#122): prísny typový systém – žiadne any, object, {}, Function ani Record<string, unknown>.
// Výnimka len s komentárom eslint-disable a dôvodom (… -- dôvod). JS súbory sa lintujú až po prepise do .ts.
import tseslint from 'typescript-eslint';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';

export default tseslint.config(
  { ignores: ['node_modules/**', 'data/**', 'public/**', 'debug/**', '**/*.js', '**/*.mjs'] },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, comments.recommended],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-restricted-types': ['error', {
        types: {
          object: { message: 'Popíš tvar objektu rozhraním alebo typom.' },
          '{}': { message: '{} znamená „čokoľvek okrem null/undefined“ – popíš tvar.' },
          Object: { message: 'Popíš tvar objektu rozhraním alebo typom.' },
          Function: { message: 'Uveď presný typ funkcie, napr. (x: number) => void.' },
          'Record<string, unknown>': { message: 'Popíš kľúče a hodnoty presne (rozhranie alebo Record<Kluc, Hodnota>).' },
          'Record<string, any>': { message: 'Popíš kľúče a hodnoty presne (rozhranie alebo Record<Kluc, Hodnota>).' },
        },
      }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // test() z node:test vracia Promise, ktorý spúšťač testov sleduje sám – testy sa prenášajú 1:1 bez await/void
      '@typescript-eslint/no-floating-promises': ['error', { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },
);
