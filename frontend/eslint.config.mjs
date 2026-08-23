import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      /**
       * Warn, not error.
       *
       * This app is a static export: there is no server render that can read
       * `localStorage`, `document` or an auth token, so every one of those
       * reads has to happen in an effect and then set state. Data fetching is
       * the same shape — `setLoading(true)` ahead of an awaited request. The
       * rule cannot see through either, and flagged 23 sites that were all
       * doing the only thing they could do.
       *
       * Kept on as a warning because the antipattern it exists to catch —
       * deriving state from props in an effect instead of computing it during
       * render — is real, and worth seeing when it is genuinely that. Demoted
       * because 23 unfixable errors is how a lint run stops being read at all.
       */
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
