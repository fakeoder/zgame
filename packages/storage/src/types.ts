export type SaveValue = ArrayBuffer | Blob | string | number | boolean | null | object;

export interface SaveMeta {
  slot: string;
  updatedAt: number;
}

/** 游戏侧统一存档接口（设计文档 §25）。游戏不感知底层实现。 */
export interface GameStorage {
  save(slot: string, data: SaveValue): Promise<void>;
  load(slot: string): Promise<SaveValue | null>;
  delete(slot: string): Promise<void>;
  list(): Promise<SaveMeta[]>;
}
