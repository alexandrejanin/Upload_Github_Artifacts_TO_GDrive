import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        ignores: [
            "dist/",
            "node_modules/",
            "temp/",
            "coverage/"
        ],
        rules: {
            // Restore user preferences from legacy .eslintrc.js
            'no-trailing-spaces': 'off',
            'comma-dangle': ['error', 'only-multiline'],
            'max-len': ['error', { code: 120 }],
            'padding-line-between-statements': 'off',
            'arrow-parens': 'off',
            'no-restricted-properties': 'off',
            'arrow-body-style': 'off',
            'no-loop-func': 'off',

            // Additional overrides for common patterns
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off', // Actions often use console.log
        },
    },
];
