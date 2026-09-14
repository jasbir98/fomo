import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The codebase's established idiom for dropping a field before a rest
      // spread is `{ field: _field, ...rest }` — ignoreRestSiblings stops
      // the discarded sibling from tripping no-unused-vars (used in
      // app/api/places/route.ts, lib/events/getForDestination.ts,
      // lib/experiences/getForDestination.ts).
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python scraper pipeline lives alongside the Next.js app but isn't
    // part of its source tree — its venv/browser-profile/output dirs must
    // never be linted as JS/TS.
    "scraper/.venv/**",
    "scraper/.pw-profile/**",
    "scraper/out/**",
    "node_modules/**",
  ]),
]);

export default eslintConfig;
