CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  allowed_senders TEXT NOT NULL, -- json
  roster TEXT NOT NULL, -- json
  next_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE records (
  trip_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  dedupe TEXT,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, seq)
);
