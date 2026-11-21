import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest"],
  categories: {
    correctness: "error",
  },
  rules: {},
  env: {
    builtin: true,
  },
});
