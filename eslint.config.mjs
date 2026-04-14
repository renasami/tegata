import tseslint from "typescript-eslint";
import functional from "eslint-plugin-functional";

export default tseslint.config(
  // Ignore build output and config files without tsconfig coverage
  { ignores: ["dist/", "node_modules/", "vitest.config.ts"] },

  // Base: strict type-checked rules (includes no-explicit-any, no-unsafe-*,
  // no-floating-promises, no-misused-promises, await-thenable,
  // prefer-promise-reject-errors, restrict-template-expressions, etc.)
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

  // Project rules for all TS files (overrides / additions to preset)
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

      // Strict boolean checks (allow nullable object/boolean to reduce
      // boilerplate with optional fields like riskScore?, description?)
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowNullableObject: true, allowNullableBoolean: true },
      ],

      // Nullish coalescing over ||
      "@typescript-eslint/prefer-nullish-coalescing": "error",

      // Unused vars (allow _ prefix for intentional ignores)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],

      // Off: some methods are async for future await points (review/approve flows)
      "@typescript-eslint/require-await": "off",
    },
  },

  // Public API must have explicit return types for stable .d.ts output
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },

  // No-throw enforcement: all src (SDK contract — Result pattern only)
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    plugins: { functional },
    rules: {
      "functional/no-throw-statements": "error",
    },
  },

  // No-try enforcement: core only (bindings may catch third-party errors)
  {
    files: ["src/core/**/*.ts"],
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "functional/no-try-statements": "error",
    },
  },

  // Disable type-checked rules for config files
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
