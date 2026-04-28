import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

export default defineConfig(
  [
    globalIgnores(["main.js"]),
    {
      files: ["**/*.{ts,tsx}"],
      plugins: { "simple-import-sort": simpleImportSort },
      extends: [
        js.configs.recommended,
        tseslint.configs.eslintRecommended,
        tseslint.configs.recommended,
      ],
      languageOptions: {
        ecmaVersion: 2020,
        globals: globals.browser,
      },
      ignores: ["main.js"],
      rules: {
        "simple-import-sort/imports": "error",
        "simple-import-sort/exports": "error",
      },
    },
  ],
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
);
