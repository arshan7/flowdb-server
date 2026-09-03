import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // The codebase logs deliberately (startup line, pool errors, per-source
      // sync failures) and already flags each with an inline disable; keep
      // the rule so a stray console.log still shows up.
      "no-console": "warn",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["**/*.test.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
