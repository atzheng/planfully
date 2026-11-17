import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/** Applies migrations/*.sql to this test file's (fresh) D1. Idempotent. */
export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

export interface TripRow {
  id: string;
  address: string;
  name: string;
  public_key: string;
  access_token_hash: string;
  dedupe_key: string;
  allowed_senders: string;
  roster: string;
  next_seq: number;
  created_at: string;
}

let counter = 0;

/** Inserts a trips row directly and returns it. Overrides replace defaults. */
export async function makeTrip(overrides: Partial<TripRow> = {}): Promise<TripRow> {
  counter += 1;
  const id = overrides.id ?? `trip-${counter}`;
  const row: TripRow = {
    id,
    address: `${id}@trips.example.com`,
    name: 'Test trip',
    public_key: 'pk',
    access_token_hash: 'hash',
    dedupe_key: 'dedupe',
    allowed_senders: '[]',
    roster: '[]',
    next_seq: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO trips (id, address, name, public_key, access_token_hash, dedupe_key, allowed_senders, roster, next_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.address,
      row.name,
      row.public_key,
      row.access_token_hash,
      row.dedupe_key,
      row.allowed_senders,
      row.roster,
      row.next_seq,
      row.created_at,
    )
    .run();
  return row;
}
