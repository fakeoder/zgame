import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const sqlText = {
  name: "sql-text",
  enforce: "pre" as const,
  load(id: string) {
    if (id.endsWith(".sql")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf8"))}`;
    }
  },
};

export default defineConfig({
  plugins: [sqlText],
  test: {
    include: ["packages/*/test/**/*.test.ts", "worker/test/**/*.test.ts", "games/*/test/**/*.test.ts"],
    environment: "node",
  },
});
