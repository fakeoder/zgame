import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(new URL("../../migrations/0001_init.sql", import.meta.url));

interface FakeStatement {
  bind(...params: unknown[]): FakeStatement;
  /** batch 用：同步执行这条语句。 */
  exec(): void;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean }>;
}

/**
 * 用 node:sqlite 跑真 SQL 的最小 D1 替身。
 * `batch` 在一个同步执行的事务里跑完，语句之间不会被其他请求插队——
 * 与 D1「batch 即逻辑事务」的语义一致，因此能复现/暴露并发 join 的竞态。
 */
export function createDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(MIGRATION, "utf8"));

  const prepare = (sql: string): FakeStatement => {
    const stmt = raw.prepare(sql);
    const make = (params: unknown[]): FakeStatement => ({
      bind: (...more) => make([...params, ...more]),
      exec: () => {
        stmt.run(...(params as never[]));
      },
      first: async <T>() => (stmt.get(...(params as never[])) as T | undefined) ?? null,
      all: async <T>() => ({ results: stmt.all(...(params as never[])) as T[], success: true }),
      run: async () => {
        stmt.run(...(params as never[]));
        return { success: true };
      },
    });
    return make([]);
  };

  const db = {
    prepare,
    async batch(stmts: FakeStatement[]) {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) s.exec();
        raw.exec("COMMIT");
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
      return stmts.map(() => ({ success: true, results: [] }));
    },
  };

  return { db: db as unknown as D1Database, raw };
}
