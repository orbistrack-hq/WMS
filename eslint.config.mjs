// ESLint 9 flat config for Next.js 16.
// eslint-config-next ships native flat-config arrays, so we spread them
// directly — do NOT wrap them in FlatCompat (that expects the legacy
// eslintrc format and throws a circular-structure error).
import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypeScript from "eslint-config-next/typescript"

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
]

export default eslintConfig
