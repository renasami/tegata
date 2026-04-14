import tseslint from "typescript-eslint";
import functional from "eslint-plugin-functional";

export default tseslint.config(
  // Ignore build output
  { ignores: ["dist/", "node_modules/", "vitest.config.ts"] },

  // Base: strict type-checked rules
  ...tseslint.configs.strictTypeChecked,

  // Typed linting setup
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project rules for all TS files
  {
    rules: {
      // Type definitions: type only, no interface
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Import/export discipline
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-require-imports": "error",

      // Switch exhaustiveness (no default needed if exhaustive)
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { allowDefaultCaseForExhaustiveSwitch: false },
      ],

      // Strict boolean checks
      "@typescript-eslint/strict-boolean-expressions": "error",

      // Promise safety
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",

      // Nullish coalescing over ||
      "@typescript-eslint/prefer-nullish-coalescing": "error",

      // Template literal safety
      "@typescript-eslint/restrict-template-expressions": "error",

      // Unused vars (allow _ prefix for intentional ignores)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],

      // Allow async without await (propose() is intentionally async for future use)
      "@typescript-eslint/require-await": "off",
    },
  },

  // No-throw enforcement: core only
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    plugins: { functional },
    rules: {
      "functional/no-throw-statements": "error",
      "functional/no-try-statements": "error",
    },
  },

  // Disable type-checked rules for config files
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
