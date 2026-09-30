import schemaSql from "../migrations/0001_init.sql";

/** 由 migrations/0001_init.sql 创建的表；启动时核对，缺一即重建（全 IF NOT EXISTS）。 */
const REQUIRED_TABLES = ["rooms", "players", "sessions", "signals"] as const;

let ready: Promise<void> | null = null;

async function bootstrap(db: D1Database): Promise<void> {
  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .bind(...REQUIRED_TABLES)
    .first<{ n: number }>();
  if ((row?.n ?? 0) === REQUIRED_TABLES.length) return;
  await db.batch(splitStatements(schemaSql).map((s) => db.prepare(s)));
}

/** 剥掉 `--` 注释后按 `;` 切成单条语句（migrations SQL 里没有字符串字面量含分号）。 */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 确保 zgame 的表存在。每个 isolate 只检查一次（缓存 Promise）；
 * 并发请求共享同一次执行，失败则清缓存、下次请求重试。
 */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = bootstrap(db).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** 测试用：清空 isolate 级缓存。 */
export function resetSchemaCache(): void {
  ready = null;
}
