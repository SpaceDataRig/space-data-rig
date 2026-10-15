// ESLint flat config (audit finding #5: the repo had no linter). Deliberately CONSERVATIVE: it
// gates on real-bug classes but demotes style/typing opinions to warnings, so switching on lint
// does not require reformatting the entire existing tree in one shot. Run `npm run lint` (fails on
// errors; warnings are advisory). Tighten rule-by-rule over time.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "dist/**",
      ".wrangler/**",
      "web/**",
      "openrig/**",
      "reports/**",
      "tests/fixtures/**",
      "**/*.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    rules: {
      // TypeScript already enforces undefined refs via `tsc`; the JS no-undef rule false-positives
      // on ambient/node globals in a no-@types-eslint setup.
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      // Non-null assertions and `any` casts are used deliberately at parser/FITS boundaries.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // audit-10 #11: research tooling under scripts/ leans on `any` casts for parsed JSON/CLI and keeps
    // exploratory vars; both opinions are OFF there so `npm run lint --max-warnings 0` gates the whole tree.
    // Production (src/) and tests keep BOTH rules strict -- src has zero no-explicit-any today.
    files: ["scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
