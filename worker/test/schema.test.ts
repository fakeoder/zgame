import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, resetSchemaCache } from "../src/schema.js";

interface FakeDb {
  db: D1Database;
  batch: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
}

function fakeDb(existingTables: string[], opts: { failBatch?: boolean } = {}): FakeDb {
  const prepare = vi.fn((sql: string) => ({
    sql,
    bind: (...names: unknown[]) => ({
      first: async () => ({
        n: names.filter((t) => typeof t === "string" && existingTables.includes(t)).length,
      }),
    }),
  }));
  const batch = vi.fn(async (stmts: { sql: string }[]) => {
    if (opts.failBatch) throw new Error("batch failed");
    for (const s of stmts) expect(s.sql).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
    return stmts.map(() => ({ results: [], success: true }));
  });
  return { db: { batch, prepare } as unknown as D1Database, batch, prepare };
}

afterEach(() => resetSchemaCache());

/** 只统计核对表存在性的那条 sqlite_master 查询。 */
function checkQueries(prepare: ReturnType<typeof vi.fn>): number {
  return prepare.mock.calls.filter((c) => String(c[0]).includes("sqlite_master")).length;
}

describe("ensureSchema", () => {
  it("表齐全时不执行 DDL", async () => {
    const { db, batch, prepare } = fakeDb(["rooms", "players", "sessions", "signals"]);
    await ensureSchema(db);
    expect(checkQueries(prepare)).toBe(1);
    expect(batch).not.toHaveBeenCalled();
  });

  it("缺表时执行 DDL，且每个 isolate 只做一次", async () => {
    const { db, batch, prepare } = fakeDb(["rooms"]);
    await ensureSchema(db);
    await ensureSchema(db);
    expect(checkQueries(prepare)).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
    // 4 张表 + 3 个索引
    expect(batch.mock.calls[0]?.[0]).toHaveLength(7);
  });

  it("并发调用共享同一次 bootstrap", async () => {
    const { db, batch, prepare } = fakeDb([]);
    await Promise.all([ensureSchema(db), ensureSchema(db), ensureSchema(db)]);
    expect(checkQueries(prepare)).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("DDL 失败后清缓存，下次请求重试", async () => {
    const failing = fakeDb([], { failBatch: true });
    await expect(ensureSchema(failing.db)).rejects.toThrow("batch failed");
    expect(failing.batch).toHaveBeenCalledTimes(1);

    const retry = fakeDb([]);
    await ensureSchema(retry.db);
    expect(retry.batch).toHaveBeenCalledTimes(1);
  });
});
