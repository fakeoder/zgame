-- rooms: 房间（设计文档 §29）
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_heartbeat INTEGER,
    -- 进入 HOST_LOST 前的状态，心跳恢复时用它回退
    resume_status TEXT
);

-- players: 房间内的玩家（Host 也在其中，role='host'）
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    nickname TEXT,
    role TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT 'player',
    joined_at INTEGER NOT NULL,
    last_seen INTEGER
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);

-- sessions: Token（仅存哈希）
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id);

-- signals: 信令队列（轮询读取，握手后清理）
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_room ON signals(room_id, id);
