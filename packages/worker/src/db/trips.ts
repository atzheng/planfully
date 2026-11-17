import { toBase64 } from '@planfully/shared';
import type { RosterMember } from '@planfully/shared';
import type { Env } from '../env';

/** Full row, camelCase. Contains secrets (dedupeKey, accessTokenHash): never serialise directly. */
export interface TripRow {
  id: string;
  /** Full address, lowercase: `<slug>-<6 random>@<TRIP_DOMAIN>`. */
  address: string;
  name: string;
  /** base64url */
  publicKey: string;
  accessTokenHash: string;
  /** base64 of 32 random bytes */
  dedupeKey: string;
  allowedSenders: string[];
  roster: RosterMember[];
  nextSeq: number;
  createdAt: string;
}

interface RawTripRow {
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

function fromRaw(r: RawTripRow): TripRow {
  return {
    id: r.id,
    address: r.address,
    name: r.name,
    publicKey: r.public_key,
    accessTokenHash: r.access_token_hash,
    dedupeKey: r.dedupe_key,
    allowedSenders: JSON.parse(r.allowed_senders) as string[],
    roster: JSON.parse(r.roster) as RosterMember[],
    nextSeq: r.next_seq,
    createdAt: r.created_at,
  };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomAlnum(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += ALNUM[b % ALNUM.length];
  return out;
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lowercase ascii slug, at most 20 chars; 'trip' when nothing usable is left. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 20)
    .replace(/^-+|-+$/g, '');
  return s || 'trip';
}

export interface NewTrip {
  name: string;
  publicKey: string;
  accessTokenHash: string;
  roster: RosterMember[];
  allowedSenders: string[];
}

/** D1 reports `D1_ERROR: UNIQUE constraint failed: trips.address: SQLITE_CONSTRAINT`. */
export function isAddressCollision(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err);
  return /UNIQUE constraint failed: trips\.address/i.test(msg);
}

export async function createTrip(env: Env, input: NewTrip): Promise<TripRow> {
  const domain = env.TRIP_DOMAIN.toLowerCase();
  for (let attempt = 0; ; attempt++) {
    const row: TripRow = {
      id: randomId(),
      address: `${slugify(input.name)}-${randomAlnum(6)}@${domain}`,
      name: input.name,
      publicKey: input.publicKey,
      accessTokenHash: input.accessTokenHash,
      dedupeKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      allowedSenders: input.allowedSenders,
      roster: input.roster,
      nextSeq: 0,
      createdAt: new Date().toISOString(),
    };
    try {
      await env.DB.prepare(
        `INSERT INTO trips (id, address, name, public_key, access_token_hash, dedupe_key, allowed_senders, roster, next_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.id,
          row.address,
          row.name,
          row.publicKey,
          row.accessTokenHash,
          row.dedupeKey,
          JSON.stringify(row.allowedSenders),
          JSON.stringify(row.roster),
          row.nextSeq,
          row.createdAt,
        )
        .run();
      return row;
    } catch (err) {
      // Address collision (UNIQUE) is vanishingly rare; retry with a new suffix. Anything else propagates.
      if (!isAddressCollision(err) || attempt >= 4) throw err;
    }
  }
}

export async function getTripById(env: Env, id: string): Promise<TripRow | null> {
  const r = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first<RawTripRow>();
  return r ? fromRaw(r) : null;
}

/** Case-insensitive on the whole address. */
export async function getTripByAddress(env: Env, address: string): Promise<TripRow | null> {
  const r = await env.DB.prepare('SELECT * FROM trips WHERE lower(address) = ?')
    .bind(address.trim().toLowerCase())
    .first<RawTripRow>();
  return r ? fromRaw(r) : null;
}

export interface TripPatch {
  name?: string;
  roster?: RosterMember[];
  allowedSenders?: string[];
}

/**
 * Applies the given fields in a single UPDATE (only the provided columns, so concurrent patches of
 * different fields do not clobber each other); returns the updated row, or null if the trip does not exist.
 */
export async function updateTrip(env: Env, id: string, patch: TripPatch): Promise<TripRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.roster !== undefined) {
    sets.push('roster = ?');
    values.push(JSON.stringify(patch.roster));
  }
  if (patch.allowedSenders !== undefined) {
    sets.push('allowed_senders = ?');
    values.push(JSON.stringify(patch.allowedSenders));
  }
  if (sets.length === 0) return getTripById(env, id);
  const r = await env.DB.prepare(`UPDATE trips SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first<RawTripRow>();
  return r ? fromRaw(r) : null;
}
