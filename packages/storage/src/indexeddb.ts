import type { GameStorage, SaveMeta, SaveValue } from "./types.js";

const DB_NAME = "WebGameHub";
const DB_VERSION = 1;
const STORE_SAVES = "saves";
const STORE_SETTINGS = "settings";
const STORE_ROOMS = "local_rooms";

interface SaveRecord {
  gameId: string;
  slot: string;
  data: SaveValue;
  updatedAt: number;
}

export function openDatabase(name = DB_NAME, version = DB_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SAVES)) {
        const store = db.createObjectStore(STORE_SAVES, { keyPath: ["gameId", "slot"] });
        store.createIndex("byGame", "gameId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        db.createObjectStore(STORE_ROOMS, { keyPath: "roomId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

/** IndexedDB 实现（设计文档 §23）。 */
export class IndexedGameStorage implements GameStorage {
  #db: Promise<IDBDatabase>;
  #gameId: string;

  constructor(gameId: string, dbName = DB_NAME) {
    this.#gameId = gameId;
    this.#db = openDatabase(dbName);
  }

  async #tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  async save(slot: string, data: SaveValue): Promise<void> {
    const record: SaveRecord = {
      gameId: this.#gameId,
      slot,
      data,
      updatedAt: Date.now(),
    };
    await this.#tx(STORE_SAVES, "readwrite", (s) => s.put(record));
  }

  async load(slot: string): Promise<SaveValue | null> {
    const rec = await this.#tx<SaveRecord | undefined>(STORE_SAVES, "readonly", (s) =>
      s.get([this.#gameId, slot]),
    );
    return rec ? rec.data : null;
  }

  async delete(slot: string): Promise<void> {
    await this.#tx(STORE_SAVES, "readwrite", (s) => s.delete([this.#gameId, slot]));
  }

  async list(): Promise<SaveMeta[]> {
    const db = await this.#db;
    return new Promise<SaveMeta[]>((resolve, reject) => {
      const tx = db.transaction(STORE_SAVES, "readonly");
      const index = tx.objectStore(STORE_SAVES).index("byGame");
      const req = index.getAll(IDBKeyRange.only(this.#gameId));
      const out: SaveMeta[] = [];
      req.onsuccess = () => {
        for (const rec of req.result as SaveRecord[]) {
          out.push({ slot: rec.slot, updatedAt: rec.updatedAt });
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(out);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  }
}

/** 内存实现：SSR / 测试 / IndexedDB 不可用时的回退。 */
export class MemoryGameStorage implements GameStorage {
  #gameId: string;
  #map = new Map<string, { data: SaveValue; updatedAt: number }>();

  constructor(gameId = "memory") {
    this.#gameId = gameId;
  }

  get gameId(): string {
    return this.#gameId;
  }

  async save(slot: string, data: SaveValue): Promise<void> {
    this.#map.set(slot, { data, updatedAt: Date.now() });
  }

  async load(slot: string): Promise<SaveValue | null> {
    return this.#map.get(slot)?.data ?? null;
  }

  async delete(slot: string): Promise<void> {
    this.#map.delete(slot);
  }

  async list(): Promise<SaveMeta[]> {
    return [...this.#map.entries()]
      .map(([slot, v]) => ({ slot, updatedAt: v.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export function createGameStorage(gameId: string): GameStorage {
  try {
    if (typeof indexedDB !== "undefined") return new IndexedGameStorage(gameId);
  } catch {
    // fall through to memory
  }
  return new MemoryGameStorage(gameId);
}
