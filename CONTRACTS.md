# Planfully contracts

The interfaces that beads share. SPEC.md says what the product does; this file fixes names, shapes and file locations so that beads built separately fit together. If a bead needs to change something here, change this file in the same commit and say so in the bead's closing note.

## 1. Layout

```
packages/shared/src/
  schema.ts        zod schemas and types (section 2)
  records.ts       record types (section 3)
  time.ts          time helpers (section 2)
  crypto.ts        section 4
  fold.ts          section 3
  index.ts         re-exports everything above
packages/worker/
  wrangler.jsonc
  migrations/0001_init.sql
  src/index.ts               export default { fetch, email }
  src/env.ts                 Env type (section 8)
  src/api/app.ts             Hono app; mounts the routers below
  src/api/auth.ts            admin + access-token middleware
  src/api/trips.ts  records.ts  blobs.ts  geocode.ts     one router each
  src/db/trips.ts  src/db/records.ts                     D1 access
  src/storage/blobs.ts                                   R2 access
  src/email/handler.ts  types.ts  routes/default.ts  routes/receipts.ts
  src/llm/parse.ts  prompt.ts
  src/geo/geocode.ts
  scripts/seed.ts  scripts/eval-llm.ts
  test/fixtures/emails/*.eml
packages/web/src/
  main.tsx  App.tsx (shell, router, providers)
  lib/api.ts  lib/queryState.ts
  create/CreateTrip.tsx
  trip/store.ts  trip/actions.ts  trip/attachments.ts  trip/compact.ts
  filters/filter.ts  filters/FilterBar.tsx
  event/EventSheet.tsx  event/EventForm.tsx
  timeline/scale.ts  layout.ts  Timeline.tsx  WeatherStrip.tsx
  map/MapView.tsx
  weather/resolve.ts  weather/openMeteo.ts
  export/pdf.ts  export/ics.ts  export/ExportMenu.tsx
  settings/Settings.tsx
  offline/db.ts  offline/queue.ts
```

Skeleton beads create placeholder files at these paths (routers, `Timeline.tsx`, `MapView.tsx`, email routes) so later beads fill in a file instead of editing a shared one.

Libraries, fixed: pnpm, TypeScript, vitest, zod, luxon (time), `@noble/curves` + `@noble/hashes`, Hono, `@cloudflare/vitest-plugin` (successor of vitest-pool-workers), postal-mime, `@anthropic-ai/sdk`, React, react-router, zustand, plain CSS modules with CSS variables (no Tailwind), `@vis.gl/react-google-maps`, jsPDF + jspdf-autotable (lazy-loaded), `idb`, vite-plugin-pwa. Use the current stable version of each. Do not add other runtime dependencies without a reason written in the bead's closing note.

## 2. Shared types (`schema.ts`, `time.ts`)

```ts
type EventType =
  | 'flight'
  | 'train'
  | 'bus'
  | 'ferry'
  | 'car'
  | 'lodging'
  | 'dining'
  | 'activity'
  | 'attraction'
  | 'receipt'
  | 'other';
type LocalTime = { local: string; tz: string }; // local: 'YYYY-MM-DDTHH:mm', tz: IANA zone
type Location = { name?: string; address?: string; lat?: number; lng?: number; placeId?: string };
type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'file' | 'source-email';
}; // id = blob id
type Event = {
  id: string; // uuid
  name: string;
  type: EventType;
  start?: LocalTime;
  end?: LocalTime;
  confirmation?: string;
  location?: Location;
  endLocation?: Location; // arrival point for transport
  attachments: Attachment[];
  participants: string[]; // roster ids; [] means everyone
  status: 'confirmed' | 'cancelled';
  notes?: string;
  source: 'email' | 'manual';
  needsReview?: boolean;
  createdAt: string; // ISO instant
  pinned?: string[]; // field names set by hand; see section 3
  deleted?: boolean; // tombstone; see section 3
};
type RosterMember = { id: string; name: string; aliases: string[] };
type TripMeta = {
  id: string;
  name: string;
  address: string /* full lowercase: slug-xxxxxx@domain */;
  domain: string;
  publicKey: string /* base64url */;
  roster: RosterMember[];
  allowedSenders: string[];
  createdAt: string;
};
```

Each type has a zod schema named `<Type>Schema`. `eventsJsonSchema` is the JSON Schema for `ParsedEvent[]` (section 6) for LLM structured output.

`time.ts` (luxon): `toInstant(t: LocalTime): number` (epoch ms), `fromInstant(ms: number, tz: string): LocalTime`, `dayKey(t: LocalTime): string` ('YYYY-MM-DD' in the event's zone), `eventInterval(e: Event): { start: number; end: number } | null` (null when unscheduled; `end` defaults to `start`).

## 3. Records and folding (`records.ts`, `fold.ts`)

Plaintext record body, JSON-encoded then sealed:

```ts
type RecordBody =
  | {
      kind: 'put';
      event: Event;
      compaction?: { firstSeq: number; throughSeq: number; aliases: string[] };
    }
  | { kind: 'patch'; target: string; fields: Partial<Omit<Event, 'id'>> } // optional fields may be null: clears them
  | { kind: 'delete'; target: string }; // same as patch { deleted: true }
```

What the server stores and returns (it never sees the body):

```ts
type StoredRecord = {
  seq: number;
  dedupe: string | null;
  ciphertext: string /* base64 */;
  createdAt: string;
};
type OpenedRecord = { seq: number; dedupe: string | null; createdAt: string; body: RecordBody };
```

`fold(records: OpenedRecord[]): Event[]` — process in `seq` order:

1. **Grouping.** `put` records belong to the same event if they share a non-null `dedupe` tag or the same `event.id`. The event's id is the id of the earliest put in the group; every other put id in the group is an alias.
2. **put.** Later put wins field by field, except fields listed in the event's `pinned`, which a put with `source: 'email'` never overwrites. Attachments are unioned by `id`. `status: 'cancelled'` sticks unless a later patch sets it back.
3. **patch.** `target` may be the id or any alias. Sets the given fields and adds their names to `pinned`. `null` on an optional field (`start`, `end`, `confirmation`, `location`, `endLocation`, `notes`, `needsReview`) removes it. Attachments in a patch replace the list; attachments the patch removed are tombstoned (below).
4. **delete.** Sets `deleted: true` and pins it.
5. Output omits events with `deleted: true`. A patch or delete whose target is unknown is ignored.

`planCompaction(records: OpenedRecord[], minRecords = 4): { write: { body: RecordBody; dedupe: string | null }; deleteSeqs: number[] }[]` — for each group with at least `minRecords` records, one `put` holding the folded event (including `pinned` and `deleted`) and a `compaction` marker, carrying the group's dedupe tag, and the seqs it replaces. The marker is `{ firstSeq: seq of the group's earliest put (or its own firstSeq if already compacted), throughSeq: max seq replaced, aliases: every non-canonical put id }`. Folding the log before and after applying a plan must give the same events, including when both old and new records are present.

Decisions made while implementing `fold.ts` (ambiguities in the rules above):

- **Grouping is global, replay is per group.** Puts are joined transitively (union-find) by shared non-null dedupe tag or shared `event.id`; each group is then replayed in `seq` order. A patch/delete joins the group that owns its target id (canonical or alias) only if its `seq` is greater than the seq of the first put that introduced that id (for an alias recorded by a compacted put, that put's `firstSeq`); otherwise it is "unknown" and ignored. So a later put that bridges two groups never revives patches written before their target existed.
- **Absent fields.** A put only overwrites fields it defines; an absent optional field keeps the earlier value. A patch clears an optional field with `null` (the field is removed and pinned, so a later email does not refill it). `null` is not allowed on required fields, `pinned` or `deleted`.
- **Pinning.** `pinned` is the sorted union of all puts' `pinned` and every field name set by a patch (a patch's own `pinned` key is unioned, not set). Only `source: 'email'` puts respect pins; a `manual` put overwrites pinned fields. `delete` is `patch { deleted: true }`, so `'deleted'` is pinned and a later email cannot undelete.
- **cancelled sticks** only against `source: 'email'` puts; a manual put or a patch may set it back.
- **Attachments** from puts always union by id (existing first), even if `attachments` is pinned. A patch replaces the list and tombstones every id it dropped: puts later in replay order cannot re-add a tombstoned id, until a later patch lists it again. Tombstones live only in replay (no stored field), and a compacted snapshot resets them.
- **createdAt** is the earliest put's. **id** is always the canonical id.
- **Output order** is `(createdAt, id)` ascending, so it is stable across compaction.
- **Compacted puts.** A put with `compaction` is a snapshot of a whole group. In replay order it sits right after `throughSeq` (sort key `throughSeq + 0.5`, ties by seq); for choosing the canonical id and for the orphan rule it counts as `firstSeq`. Its `aliases` and `event.id` join the union-find and the alias lookup, so patches to an alias still resolve. Replaying it sets the state to its event wholesale (regardless of source and pins); records with seq above `throughSeq` then apply normally, including ones that landed in the log before the compacted put did (a concurrent edit between plan and write is kept). Old records at or below `throughSeq` may still be present: they replay first and the snapshot overrides them.
- **planCompaction** counts all records in a group (puts plus applicable patches/deletes) toward `minRecords`. Re-compacting a group that already holds a compacted put carries its `firstSeq` and aliases forward (they are recomputed from the group). A group whose replay ends with attachment tombstones is skipped (a snapshot cannot carry them). A group with several distinct dedupe tags gets one identical snapshot per tag (a record carries one tag, and a later email with any of the tags must still join the group); the plan entries for it come in tag order and `deleteSeqs` are on the last one only, so a client that stops part way has deleted nothing and every tag is still covered. `compactTrip` writes plan entries in order, so it needs no special handling.

Known limitations (accepted for now):

- A late put that bridges two groups after one of them was compacted: the snapshot replays at `throughSeq + 0.5` and overrides the other group's earlier puts, which an uncompacted log would have merged in seq order.
- Groups with attachment tombstones are never compacted, so a heavily edited event whose attachments were removed keeps its records.
- A patch cannot restore a required field to "absent", and the web edit form still clears with `''` / `{}` (see `event/formModel.ts`); it can move to `null` later.

Version skew (old client reading logs written by a new client):

- Attachment tombstones, bridge handling and per-tag snapshots add no new record shape. An old client folds the same log with the old rules: an email can re-add a removed attachment, a late bridge applies earlier patches retroactively, and per-tag snapshots are ordinary compacted puts (identical events, so no visible effect).
- A patch with a `null` field fails the old `RecordBodySchema` (strict), so an old client counts it as a skipped (unopenable) record: it does not see the clear, and `compactTrip` refuses to compact while any record is skipped. Nothing else is lost. Old logs fold identically under the new rules except where a patch removed an attachment before a later put re-listed it, or a put bridged groups after patches that named a not-yet-existing id.

**Dedupe tag input (email ingest, `routes/default.ts`).** Events without a `confirmation` get no tag. Otherwise `dedupeTag(dedupeKey, type, input)` where `input` is the confirmation for non-transport types, and for `flight|train|bus|ferry|car` `${confirmation}|${placeKey(location)}|${placeKey(endLocation)}|${start ? dayKey(start) : ''}` (each leg of a multi-leg booking, and each day of a repeated route, gets its own tag; `dedupeTag` strips non-alphanumerics). `placeKey(loc.name)`: a 3-letter capital code counts only if parenthesised `(CDG)`, the whole trimmed name (`CDG`), or next to an airport marker (`Airport`, `Aeroporto`, `Aéroport`, `Aeropuerto`, `Flughafen`, `Terminal`, `T<digit>`), e.g. `SFO Terminal 2`, `Airport JFK`; otherwise the name lowercased with diacritics stripped and non-alphanumerics removed (`NEW YORK` stays `newyork`; `NYC JFK` gives `nycjfk`). Trade-offs: a schedule change that moves a leg to a different day creates a new event instead of updating the old one (a visible duplicate the user can delete beats silently hiding a leg); same-day time changes and cancellations fold in. Code-less names worded differently ("San Francisco International" vs "SFO") also duplicate. When some events or attachments of an email fail, ingest additionally appends one needs-review `other` event (no tag, source email attached) named `Not everything from "<subject>" could be added`.

## 4. Crypto (`crypto.ts`)

```ts
generateSecret(): Uint8Array                         // 32 random bytes
encodeSecret(s: Uint8Array): string                  // base64url, no padding; this is the URL fragment
decodeSecret(s: string): Uint8Array
deriveTripKeys(secret: Uint8Array): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array; accessToken: string }>
hashAccessToken(token: string): Promise<string>      // hex SHA-256
seal(publicKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>
open(privateKey: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>   // throws on tamper/wrong key
sealJson(publicKey, value): Promise<Uint8Array>;  openJson<T>(privateKey, sealed): Promise<T>
dedupeTag(dedupeKey: Uint8Array, type: string, confirmation: string): Promise<string>
toBase64 / fromBase64 / toBase64Url / fromBase64Url
```

- Private key = HKDF-SHA256(secret, no salt, info `planfully/x25519/v1`, 32 bytes). Access token = base64url of HKDF-SHA256(secret, no salt, info `planfully/access/v1`, 32 bytes). `decodeSecret` rejects anything that is not 32 bytes. Test vectors: `packages/shared/test/vectors.json`.
- Sealed format: `0x01 | ephemeralPublicKey(32) | nonce(12) | AES-256-GCM ciphertext+tag`. AES key = HKDF-SHA256(ikm = X25519(ephemeralPrivate, recipientPublic), salt = ephemeralPublic ‖ recipientPublic, info `planfully/seal/v1`).
- X25519 and HKDF from `@noble`; AES-GCM and SHA-256 from `crypto.subtle` (native, so bulk work is cheap on Workers). No Node-only APIs.
- `dedupeTag` = hex HMAC-SHA256(dedupeKey, `${type}\n${normalised}`), normalised = confirmation uppercased with everything but A-Z0-9 removed.

## 5. HTTP API

JSON unless noted. Errors: `{ "error": string }` with a 4xx/5xx status. Trip routes need `Authorization: Bearer <accessToken>`; the server compares `hashAccessToken(token)` with the stored hash.

| Route                                                      | Request                                                        | Response                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /api/health`                                          |                                                                | `{ ok: true }`                                                                                         |
| `POST /api/trips` (`Authorization: Bearer <ADMIN_SECRET>`) | `{ name, publicKey, accessTokenHash, roster, allowedSenders }` | 201 `{ id, address, domain }` (`address` is the full `slug-xxxxxx@domain`)                             |
| `GET /api/trips/:id`                                       |                                                                | `TripMeta`                                                                                             |
| `PATCH /api/trips/:id`                                     | `{ name?, roster?, allowedSenders? }`                          | `TripMeta`                                                                                             |
| `GET /api/trips/:id/records?since=N`                       |                                                                | `{ records: StoredRecord[], latestSeq: number, more: boolean }` (seq > N, ascending; paged, see below) |
| `POST /api/trips/:id/records`                              | `{ ciphertext, dedupe? }`                                      | 201 `{ seq }`                                                                                          |
| `DELETE /api/trips/:id/records/:seq`                       |                                                                | 204                                                                                                    |
| `PUT /api/trips/:id/blobs/:blobId`                         | raw bytes, `application/octet-stream`                          | 201                                                                                                    |
| `GET /api/trips/:id/blobs/:blobId`                         |                                                                | raw bytes                                                                                              |
| `GET /api/trips/:id/geocode?q=`                            |                                                                | `{ results: Location[] }`                                                                              |

`seq` comes from a per-trip counter (`trips.next_seq`, incremented in the same D1 batch as the insert). It strictly increases and is never reused, even after deletes. Blob ids are UUIDs chosen by the writer. Limits: record ciphertext 256 KB, blob 25 MB.

Record paging: a GET returns at most 500 records. If more remain, `more` is true and `latestSeq` is the last seq in the page; otherwise `more` is false and `latestSeq` is the trip counter (`next_seq`), which can exceed the last returned seq when the tail was deleted. Clients store `latestSeq` as their cursor and, while `more` is true, immediately fetch again with `since=latestSeq`.

## 6. Worker internals

```ts
// db/trips.ts
createTrip, getTripById, getTripByAddress, updateTrip     // TripRow includes dedupeKey, accessTokenHash
// db/records.ts
appendRecord(env, tripId, r: { ciphertext: Uint8Array; dedupe?: string | null }): Promise<number>
listRecords(env, tripId, since: number): Promise<StoredRecord[]>
deleteRecord(env, tripId, seq: number): Promise<void>
// storage/blobs.ts — R2 key `trips/<tripId>/blobs/<blobId>`
putBlob(env, tripId, blobId, bytes): Promise<void>;  getBlob(env, tripId, blobId): Promise<ReadableStream | null>

// email/types.ts
type ParsedEmail = { from: string; to: string; suffix: string; subject: string; date: string;
                     text?: string; html?: string;
                     attachments: { filename: string; mime: string; bytes: Uint8Array }[];
                     sourceAttachment: Attachment }   // the sealed raw .eml, already stored
type EmailRoute = (ctx: { env: Env; trip: TripRow; email: ParsedEmail }) => Promise<void>
// email/store.ts: storeAttachment(env, trip, { filename, mime, bytes }): Promise<Attachment>  (seal + putBlob, fresh uuid, kind 'file', size = plaintext)
//                  appendEvent(env, trip, event: Event, dedupe: string | null): Promise<number>  (EventSchema-validates, seals a put, appends)
// routes/default.ts exports setLlmClientForTests(client | undefined) so tests can inject the parseEmail client; `today` = UTC day of the Date header, else now
// email/handler.ts exports handleEmail(message, env, ctx) and a mutable `routes` map; it picks routes[suffix] ?? routes[''];  '' -> routes/default.ts, 'receipts' -> routes/receipts.ts

// email/auth.ts: sender check. From must hold exactly one mailbox (postal-mime addressParser; zero, several,
// group syntax or several From headers fail closed); address lowercased, trailing dot dropped.
// Reads the FIRST Authentication-Results header (Cloudflare prepends it; authserv-id must be mx.cloudflare.net,
// later headers are sender-supplied and ignored). Passes only if a clause is dmarc=pass with header.from, or
// spf=pass with smtp.mailfrom, or dkim=pass with header.d, STRICTLY equal to the From domain (no subdomain
// matching); a pass with no domain does not count. planfully-x46.6 verifies real Cloudflare headers.
// A message whose rawSize + 61 (seal overhead) exceeds the 25 MB blob cap is rejected ('message too large').

// llm/parse.ts
type ParsedEvent = Omit<Event, 'id'|'attachments'|'source'|'createdAt'|'pinned'|'deleted'>
                 & { attachmentIndexes: number[] }    // indexes into email.attachments
parseEmail(email: ParsedEmail, opts: { roster: RosterMember[]; today: string; apiKey: string }): Promise<ParsedEvent[]>

// geo/geocode.ts — returns the input unchanged when no key is set or the match is weak
geocode(env: Env, loc: Location, session?: { blocked?: boolean; bias?: GeoBias }): Promise<Location>
// GeoBias = { latitude, longitude, radius (m, <= 50000) }; computeBias(points) is pure (unit-vector centroid).
// Name-only lookups send Places `locationBias.circle` from session.bias; ingest geocodes address-bearing
// events first and derives the bias from them (only this email's events: stored trip data is encrypted).
// name-only queries need a token overlap with the match's name; a lone lat or lng is dropped/replaced;
// 403/429 log the status only and set session.blocked so the rest of the ingest run skips lookups
```

Never log email content, event content or tokens.

## 7. Web internals

- **Routes:** `/new` (create), `/t/:tripId` (trip; secret in `location.hash`), `/t/:tripId/settings`. The secret is read from the fragment only and never placed in a query string, request URL or log.
- **`lib/api.ts`:** typed functions for section 5, taking `{ tripId, accessToken }`.
- **`lib/queryState.ts`:** `useQueryState<T>(key, codec, defaultValue): [T, (v: T) => void]`. All view state goes through it. Reserved keys: `view` (timeline|map), `q`, `type`, `from`, `to`, `who`, `cancelled`, `e` (open event id), `zoom`, `lanes` (none|type|participant), `wx` (0|1), `tz`.
- **`trip/store.ts`:** zustand store behind `<TripProvider tripId>` (reads `location.hash` once; starts/stops polling; the raw secret is not retained after key derivation) and `useTrip()` / `useTrip(selector)`, returning:
  ```ts
  { tripId: string; meta: TripMeta | null; events: Event[]; records: OpenedRecord[] /* by seq */;
    keys: { privateKey, publicKey, accessToken } | null; status: 'loading' | 'ready' | 'error';
    error: { kind: 'bad-link' | 'unauthorized' | 'undecryptable' | 'network' | 'unknown'; message: string } | null;
    skipped: number; cursor: number; offline: boolean;
    sync(): Promise<void>; append(records: OpenedRecord[]): void; setMeta(meta: TripMeta): void }
  ```
  - `events` is `fold(records)`, recomputed once per change to `records`. `skipped` counts records that failed to open or validate (cumulative); they are never thrown. `cursor` is the server's `latestSeq`, used as `since` on the next fetch.
  - Errors: missing or invalid fragment gives `bad-link` ("This link is missing its key"); 401/403/404 gives `unauthorized` ("Trip not found or wrong key"); records present but none opening gives terminal `undecryptable`; network, 429 or 5xx gives `network`; a paging response that promises more but makes no progress gives `unknown`. `hashchange` to a different secret replaces the store (`onReplace`); removing the fragment keeps the current keys. A failed initial load sets `status: 'error'` and retries with backoff (2s, 5s, 15s, then 30s). A network failure during sync keeps `status: 'ready'` and the last data and sets `error` to the `network` error; the next success clears it. A 401 during sync is fatal (`status: 'error'`).
  - `append(opened)`: for the write path; merges already-opened records by `seq` (duplicates ignored) and re-folds. It does not advance `cursor`, so the next sync still fetches records written by others in between. `setMeta` replaces `meta` after a PATCH.
  - Sync: `since=cursor`, paging while `more`; triggered on window focus, on visibilitychange to visible, and every 60 s while the page is visible. Concurrent calls share one request.
  - `createTripStore({ tripId, fragment, api?, intervalMs?, backoffMs? })` builds a store without React (for tests and caching); `openRecords(privateKey, stored)` is also exported.
  - `trip/actions.ts`: `createTripActions(store, { queue? })` and the hook `useTripActions()` return `putEvent(e: NewEvent): Promise<Event>` (id `crypto.randomUUID()`, source `manual`, createdAt now, no dedupe tag), `patchEvent(id, fields)`, `deleteEvent(id)`. Each shows a temporary record at once and hands it to the offline queue (`offline/queue.ts`, below), which seals, stores and sends it, then swaps in the real seq. The returned promise settles after the first send attempt: it resolves when sent or left queued (offline), and rejects only when the server refused it (temp record removed, `lastError` set) or it could not be stored. The old `sendRecord` option is gone (the queue is the single send step). Store additions: `pending: number`, `lastError: TripError | null`, and the write-path hooks `addOptimistic(body)` (temp seq near `MAX_SAFE_INTEGER` so it folds last), `settleOptimistic(tempSeq, real?)`, `setWriteState({ pendingDelta?, lastError? })`; `useTripStore()` returns the store. Records appended during the initial load are kept when the load result arrives. Sends are serialized by the queue in call order (a patch cannot outrun its put); a patch or delete queued behind a refused put is dropped and rejects, also across restarts. Store additions: `queueStalled: boolean` (`setWriteState({ queueStalled })`); `pending` counts record writes not yet acknowledged (in flight or queued), so compaction waits for 0. `lastError` is only cleared by the UI (`setWriteState({ lastError: null })`), never by a later success. A patch may set an optional field to `null` to clear it (section 3); the web edit form still blanks with empty values (`notes: ''`) and does not yet use null (follow-up). `isTempSeq(seq)` (store.ts) identifies temp records; compaction and offline caches must skip them. Compaction (`trip/compact.ts`): `compactTrip(store, api?, isOnline?): Promise<boolean>` runs `planCompaction` over the non-temp records: seal, `postRecord` (dedupe only when non-null), and only then `deleteRecord` for each replaced seq (404 ignored), updating the store with `append` and the new `removeRecords(seqs)`. It returns false without doing anything when offline, not ready or `pending > 0`, and re-checks `pending` before each append. The store calls it after the first successful load/sync (once per store; retried if it could not start) when its `api` has `postRecord` and `deleteRecord` (`TripApi` now includes them as optional). It does nothing while `skipped > 0` (unreadable records are invisible to the plan, and the snapshot could override them for newer clients) and stops deleting if a write starts. Version skew: an older client that strips the `compaction` key treats a compacted put as a plain put at a high seq, so patches between the replaced seqs and it may be lost for that client; roll out schema changes with this in mind. fh8.2/fh8.3: any persisted record cache must also apply `removeRecords` (or be reloaded) after compaction, or deleted records reappear from the cache. `isTempSeq` now lives in `trip/tempSeq.ts` (re-exported from store.ts; breaks the store/compact import cycle).
- **Offline cache (`offline/db.ts`, fh8.2):** IndexedDB `planfully` v2 via `idb` (v2 adds `queue`): `trips { tripId, secret, meta, lastSeq, openedAt }`, `records [tripId, seq] -> StoredRecord` (sealed), `blobs { blobId, tripId, bytes }` (sealed, index `tripId`). `createOfflineDb(name?)` / `getOfflineDb()` (null without IndexedDB) / `setOfflineDb()` (tests). The secret is stored in plain form by design (the landing page's recent-trips list links to `/t/<id>#<secret>`). `createTripStore` takes `cache?: OfflineDb | null`. Flow: after deriving keys, if the cached secret equals the fragment, the store opens the cached records and is `status: 'ready'` at once (`cursor = lastSeq`), then syncs; the first sync also refreshes `meta`. A full load (`since=0`) replaces the cached records; syncs add to them. `lastSeq` is the store `cursor`, never max(seq). The sealed pages as received are cached, so records that fail to open stay cached (and counted in `skipped`). Temp records are never persisted; `removeRecords` is applied to the cache. `append()` and `settleOptimistic(_, real)` also persist records with real seqs (re-sealed with the public key; `lastSeq` untouched), so compaction's put survives an offline reload before the next sync. A cached trip whose last full load (`fullLoadAt`) is older than 7 days is reloaded from since=0 on its first sync, replacing the cache (drops stale pre-compaction records). A 401/403/404 on a trip loaded from the cache only sets `revokedAt` on its row (data kept, since these can be transient); the landing page shows "Link no longer works" with Forget, and the next successful snapshot clears the flag. `putBlob`/`putRecords` skip trips with no cached row (no orphans after Forget). The store keeps the raw secret in memory until the first snapshot has been written to the cache: a deliberate exception to "not retained after key derivation". A stopped store does not write (hashchange to another secret replaces the store; a different cached secret is ignored and replaced). `offline: boolean` is true while the last sync failed on the network (`status` stays `'ready'`; `error` is still set as before). `TripApi` gains optional `getBlob`; after each sync small attachments (< 5 MB) are cached in the background (`prefetchAttachments`); `fetchAttachment` checks the blob cache first and caches sealed bytes after a network fetch. `forgetTrip(tripId)` removes that trip's secret, records and blobs only.
- **Offline edit queue (`offline/queue.ts`, fh8.3):** IndexedDB store `queue` (autoIncrement `id`, index `tripId`) holding `QueueItem { id, tripId, kind: 'record' | 'blob', payload /* sealed */, blobId?, op?, eventId?, blobIds?, createdAt }` (`eventId`/`blobIds` are UUIDs used only to drop dependents, never content); `forgetTrip` clears it. `createTripQueue(store, { storage?, api?, backoffMs? })` / `getTripQueue(store)` (one per store; memory-only where IndexedDB is missing) expose `enqueueRecord(body)`, `enqueueBlob(blobId, sealed)`, `flush()`, `start()`, `stop()`. `TripProvider` starts it. Records: temp record + `pending` +1 at once, then seal, append, flush; on start, persisted records are opened and shown as temp records on top of the cached log. Flush is strictly FIFO, one item at a time, under a per-trip Web Lock (`ifAvailable`; in-process mutex only where unsupported). Network failure (fetch error, 5xx, 408, 429) and 401/403/404 stop the flush, keep everything queued and visible, set `queueStalled`, and retry on `online`, focus, visibility and backoff (2, 5, 15, 30, 60 s). Any other 4xx drops the item, rolls back its temp record, sets `lastError`, and drops dependents (later patch/delete of a dropped put; records whose attachments reference a dropped blob). Sent records settle with the real seq and are persisted to the cache. A queue item sent by another tab is noticed (item gone) and its temp record removed; the real record arrives with the next sync. A POST whose response was lost is sent again; the duplicate put/patch lands before any later item of ours, so folding is unchanged (tested). TripShell shows "N changes waiting to sync" while `queueStalled`. When stalled on 401/403/404 (`queueAccessLost`) it says the link no longer has access and offers Discard (confirm; `queue.discard()` drops the items and rolls back). `lastError` is shown in a dismissible TripShell banner when the event sheet is closed. Sends abort after 30 s (records) / 120 s (blobs) and are retried; a refused blob sets `lastError` naming the file. A tab that does not get the Web Lock retries with backoff. `offline/db.ts`: the open waits at most 3 s (a tab holding an older version open blocks the upgrade; this tab closes its own handle on `blocking`), then the cache fails fast and the queue (`resilientQueueStorage`) continues in memory; the first load waits at most 1.5 s for the cache. Known limitation: a put or patch repeated after a lost response lands after anything another device wrote in between and can overwrite that device's edit to the same fields; and an edit is lost if the tab dies between showing it and storing it in the queue.
- **`trip/attachments.ts`:** `type AttachmentContext = { tripId: string; accessToken: string; privateKey: Uint8Array }` (from `useTrip`: `tripId` and `keys`); `fetchAttachment(a: Attachment, ctx: AttachmentContext): Promise<Blob>` (fetch, open, wrap with `a.mime`); `uploadAttachment(file: File, ctx: UploadContext): Promise<Attachment>` with `UploadContext = AttachmentContext & { publicKey: Uint8Array }` (spread `{ tripId, ...keys }` from `useTrip`; ecw.4). It refuses files over `MAX_UPLOAD_BYTES` (25 MB minus the 61-byte seal overhead, matching the Worker's cap on the sealed blob) with `FileTooLargeError` before reading or sealing, then seals, writes the sealed bytes to the blob cache and sends a new UUID blob (queued via `ctx.queue` when given: `UploadContext` gains optional `queue?: TripQueue`, so offline it returns at once and the blob goes out before the record that references it; without it, a direct PUT) and returns `{ kind: 'file', filename, mime: file.type || 'application/octet-stream', size }`. UI: `event/UploadButtons.tsx` exports `AttachButton({ event })` (event sheet actions row; one patch with all uploaded files) and `AddReceiptButton()` (currently in the shell's `data-slot="actions"`; one `receipt` event per file, name = filename without extension, start = now in the browser zone).
- **`filters/filter.ts`:** `type Filter`, `filterEvents(events, filter)`, `useFilter()`, `useFilteredEvents()`.
- **`event/EventSheet.tsx`:** mounted once in the shell; open an event by setting query key `e`. Views never render their own detail UI.
- **`timeline/scale.ts`:** `type TimeScale = { pxPerHour: number; originMs: number; toY(ms: number): number; toMs(y: number): number }`, `makeScale(originMs, pxPerHour)`, and `useTimeScale()` from a context provided by `Timeline`. Anything drawn beside the axis (weather) positions itself with this and nothing else. Also in scale.ts: `useVisibleRange(): { fromMs, toMs }` (the time range scrolled into view, rounded outward to whole hours so it changes rarely; side tracks use it to decide what to fetch), `DEFAULT_PX_PER_HOUR` (48). pxPerHour comes only from the zoom state in `timeline/zoom.ts`: `Timeline` calls `useZoom()` (live state, URL key `zoom` = log2(pxPerHour), written with replace 250 ms after the last change); `usePxPerHour()` reads the URL value for other components. Zoom keeps the time under the pointer / pinch midpoint / viewport centre (buttons) at the same screen y by setting `anchorMs`/`anchorY` before the scale change; the layout effect restores scrollTop. `<Timeline gutter={node}/>` renders `node` in a 64px gutter column left of the axis (`data-slot="timeline-gutter"`, same height as the axis, position:relative); the node is inside both providers. `useVisibleRange()` is never empty (`fromMs < toMs`), including on the first frame (it then spans 24 h from the scale origin until the first measurement); it is re-measured on scroll and on scroller resize (ResizeObserver). The scroller stays mounted when the filter matches nothing (empty state is an overlay) and the scroll position is kept by time: `anchorMsAt` / `scrollTopForAnchor` (model.ts) keep the time at the top of the viewport at the same screen y whenever the scale changes (filters, zoom). Lanes (gy4.8): the scroller is the ONE scroller (`overflow: auto` both ways, so zoom anchoring stays on it); gutter and axis are `position: sticky; left` and the lane header row (only in a lane mode, 32px, sticky under the day heading) is part of the canvas, so the time axis starts at `HEADING_PX + laneHead` (`topPx` in Timeline.tsx) and scroll anchoring re-anchors when that changes. Lane columns are `flex: 1 1 0; min-width: 140px`; the page never scrolls sideways. `layout.ts` also exports `LANE_MODES` and `withoutEmptyLanes(layout, mode)` (hides lanes with no blocks except in mode `none`); the `_other` lane is labelled 'Former participants'. Gutter children (the weather strip) position with `scale.toY` alone (the gutter is inside the canvas body); only scroller-space code adds `topPx`. In participant mode the `who` filter limits lanes to the selected participants. The mode control is a toolbar button group (`data-testid=lanes-<mode>`). `timeline/model.ts` holds the pure helpers (`timelineRange`, `validZone`, `localStartLabel`, type icon and hue). The scroller has a fixed height (`100dvh - 250px`, min 320px) and a sticky day heading; the canvas starts 28px below the scroller top.
- **`timeline/layout.ts`:** `layoutEvents(events, scale, lanes: { mode: 'none'|'type'|'participant'; roster: readonly RosterMember[] }): { lanes: { key, label }[]; blocks: { eventId, laneKey, top, height, column, columns }[]; unscheduled: Event[] }` — pure, unit-tested. Also `ticks(scale, fromMs, toMs, tz): { ms, label, kind: 'hour'|'day'|'week' }[]` (scale.ts) and `initialScrollMs(events, nowMs)` (layout.ts). Exported from scale.ts: `MIN_PX_PER_HOUR` (0.5), `MAX_PX_PER_HOUR` (120) and tick thresholds (hour >= 30 px/h, day >= 4, else week). Participant mode adds an `_other` lane for ids not in the roster.
- **`weather/`:** `resolve.ts` `hourlyLocations(events, fromMs, toMs): WeatherSegment[]` (`{ fromMs, toMs, lat, lng, label }`; location sampled at each hour's start; merged per place, lat/lng rounded to 2 dp; first/last segment clamped to the range; `[]` when no located events). `openMeteo.ts` `fetchHourly(segment, { nowMs?, fetchFn? }): Promise<HourlySeries>` with `HourlySeries = { coverage: { fromMs, toMs } | null; timeMs[]; tempC[]; windKph[]; precipMm[] }` (UTC instants; `coverage` is the part of the segment inside today..today+15 days, null when none, and hours in coverage missing from `timeMs` had no data; 30-minute cache, 1-minute failure cache, 100 entries max; shared in-flight requests, no caller abort signal; rejects on HTTP/network error), `clearWeatherCache()`. `useWeather(fromMs, toMs)` (rounds the range out to whole hours): `{ series: { segment, series, status: 'loading'|'ready'|'error'|'empty' }[]; status: 'idle'|'loading'|'ready'|'error' }`; `idle` means no segments (no located events); `series` always matches the current range. `units.ts`: `defaultUnits(locale?)`, `convertTemp`, `convertWind`, `formatTemp`, `formatWind`, `formatPrecip`.
- **`export/`:** `pdf.ts` `buildItinerary(events, roster, filter, { tripName, now? }): Itinerary` (pure; `{ tripName, generated, filters: string[], days: { key, label, rows }[], unscheduled: rows, count }`; rows carry display strings plus `notes`, `attachments` (filenames)), `describeFilter(filter, roster): string[]`, `renderPdf(itinerary): Promise<void>` (jsPDF + jspdf-autotable via dynamic import, saves `<trip-name>-itinerary.pdf`; a Unicode subset font from `/fonts` (Noto Sans: Latin/Greek/Cyrillic; Noto Sans JP when kana present, SC for Han alone; Thai) is fetched only when the text needs one, via `export/fonts.ts` `detectScripts`/`chooseFont`; Arabic, Hebrew, Korean, emoji and glyphs the chosen font lacks print as `?`). `ics.ts` `buildIcs(events, tripName, roster?, now?): string` (pure; CRLF, 75-octet folding, UTC DTSTART/DTEND via `toInstant`, UID `<id>@planfully`, 1-hour default when no end, skips unscheduled/deleted, STATUS:CANCELLED), `downloadIcs(events, tripName, roster)`, `icsFileName`; `pdf.ts` also exports `exportFileName(tripName, suffix)` (shared sanitiser). `ExportMenu.tsx` is mounted once in the shell actions slot; add a format by appending an entry to its `items` array.
- **Time display:** blocks are positioned by absolute instant. The axis is labelled in one display zone (query key `tz`, default the browser's zone); each event's own local times are shown in its label and sheet.

## 8. Config

Worker bindings and vars (`src/env.ts`): `DB` (D1), `BLOBS` (R2), `ASSETS` (static assets), `TRIP_DOMAIN`, `ADMIN_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`. Local values in `packages/worker/.dev.vars` (gitignored); commit `.dev.vars.example`. Web: `VITE_GOOGLE_MAPS_KEY` in `packages/web/.env.local` (gitignored); commit `.env.example`. Code must run with the two API keys unset: geocoding returns no coordinates, the map shows a "key not configured" notice, and LLM tests use a mocked client.

## 9. Commands

From the repo root: `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm dev` (Worker on :8787 and Vite on :5173 with `/api` proxied), `pnpm seed` (prints a trip URL for the local Worker). Per package: `pnpm --filter @planfully/<shared|worker|web> <script>`.
