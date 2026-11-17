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
type EventType = 'flight'|'train'|'bus'|'ferry'|'car'|'lodging'|'dining'
               |'activity'|'attraction'|'receipt'|'other'
type LocalTime = { local: string; tz: string }   // local: 'YYYY-MM-DDTHH:mm', tz: IANA zone
type Location  = { name?: string; address?: string; lat?: number; lng?: number; placeId?: string }
type Attachment = { id: string; filename: string; mime: string; size: number;
                    kind: 'file' | 'source-email' }      // id = blob id
type Event = {
  id: string                     // uuid
  name: string
  type: EventType
  start?: LocalTime
  end?: LocalTime
  confirmation?: string
  location?: Location
  endLocation?: Location         // arrival point for transport
  attachments: Attachment[]
  participants: string[]         // roster ids; [] means everyone
  status: 'confirmed' | 'cancelled'
  notes?: string
  source: 'email' | 'manual'
  needsReview?: boolean
  createdAt: string              // ISO instant
  pinned?: string[]              // field names set by hand; see section 3
  deleted?: boolean              // tombstone; see section 3
}
type RosterMember = { id: string; name: string; aliases: string[] }
type TripMeta = { id: string; name: string; address: string /* full lowercase: slug-xxxxxx@domain */; domain: string;
                  publicKey: string /* base64url */; roster: RosterMember[];
                  allowedSenders: string[]; createdAt: string }
```

Each type has a zod schema named `<Type>Schema`. `eventsJsonSchema` is the JSON Schema for `ParsedEvent[]` (section 6) for LLM structured output.

`time.ts` (luxon): `toInstant(t: LocalTime): number` (epoch ms), `fromInstant(ms: number, tz: string): LocalTime`, `dayKey(t: LocalTime): string` ('YYYY-MM-DD' in the event's zone), `eventInterval(e: Event): { start: number; end: number } | null` (null when unscheduled; `end` defaults to `start`).

## 3. Records and folding (`records.ts`, `fold.ts`)

Plaintext record body, JSON-encoded then sealed:

```ts
type RecordBody =
  | { kind: 'put';    event: Event; compaction?: { firstSeq: number; throughSeq: number; aliases: string[] } }
  | { kind: 'patch';  target: string; fields: Partial<Omit<Event, 'id'>> }
  | { kind: 'delete'; target: string }        // same as patch { deleted: true }
```

What the server stores and returns (it never sees the body):

```ts
type StoredRecord = { seq: number; dedupe: string | null; ciphertext: string /* base64 */; createdAt: string }
type OpenedRecord = { seq: number; dedupe: string | null; createdAt: string; body: RecordBody }
```

`fold(records: OpenedRecord[]): Event[]` — process in `seq` order:

1. **Grouping.** `put` records belong to the same event if they share a non-null `dedupe` tag or the same `event.id`. The event's id is the id of the earliest put in the group; every other put id in the group is an alias.
2. **put.** Later put wins field by field, except fields listed in the event's `pinned`, which a put with `source: 'email'` never overwrites. Attachments are unioned by `id`. `status: 'cancelled'` sticks unless a later patch sets it back.
3. **patch.** `target` may be the id or any alias. Sets the given fields and adds their names to `pinned`. Attachments in a patch replace the list.
4. **delete.** Sets `deleted: true` and pins it.
5. Output omits events with `deleted: true`. A patch or delete whose target is unknown is ignored.

`planCompaction(records: OpenedRecord[], minRecords = 4): { write: { body: RecordBody; dedupe: string | null }; deleteSeqs: number[] }[]` — for each group with at least `minRecords` records, one `put` holding the folded event (including `pinned` and `deleted`) and a `compaction` marker, carrying the group's dedupe tag, and the seqs it replaces. The marker is `{ firstSeq: seq of the group's earliest put (or its own firstSeq if already compacted), throughSeq: max seq replaced, aliases: every non-canonical put id }`. Folding the log before and after applying a plan must give the same events, including when both old and new records are present.

Decisions made while implementing `fold.ts` (ambiguities in the rules above):

- **Grouping is global, replay is per group.** Puts are joined transitively (union-find) by shared non-null dedupe tag or shared `event.id`; each group is then replayed in `seq` order. A patch/delete joins the group that owns its target id (canonical or alias) only if its `seq` is greater than that group's earliest put; otherwise it is "unknown" and ignored.
- **Absent fields.** A put only overwrites fields it defines; an absent optional field keeps the earlier value. A patch cannot clear an optional field (JSON has no `undefined`).
- **Pinning.** `pinned` is the sorted union of all puts' `pinned` and every field name set by a patch (a patch's own `pinned` key is unioned, not set). Only `source: 'email'` puts respect pins; a `manual` put overwrites pinned fields. `delete` is `patch { deleted: true }`, so `'deleted'` is pinned and a later email cannot undelete.
- **cancelled sticks** only against `source: 'email'` puts; a manual put or a patch may set it back.
- **Attachments** from puts always union by id (existing first), even if `attachments` is pinned. A patch replaces the list; a later email that re-lists a removed attachment brings it back.
- **createdAt** is the earliest put's. **id** is always the canonical id.
- **Output order** is `(createdAt, id)` ascending, so it is stable across compaction.
- **Compacted puts.** A put with `compaction` is a snapshot of a whole group. In replay order it sits right after `throughSeq` (sort key `throughSeq + 0.5`, ties by seq); for choosing the canonical id and for the orphan rule it counts as `firstSeq`. Its `aliases` and `event.id` join the union-find and the alias lookup, so patches to an alias still resolve. Replaying it sets the state to its event wholesale (regardless of source and pins); records with seq above `throughSeq` then apply normally, including ones that landed in the log before the compacted put did (a concurrent edit between plan and write is kept). Old records at or below `throughSeq` may still be present: they replay first and the snapshot overrides them.
- **planCompaction** counts all records in a group (puts plus applicable patches/deletes) toward `minRecords`. Re-compacting a group that already holds a compacted put carries its `firstSeq` and aliases forward (they are recomputed from the group). Groups joined by more than one distinct dedupe tag are skipped (one record carries one tag).

Known limitations (accepted for now):

- A later email put can re-add an attachment that a patch removed.
- A late put that bridges two groups (shared tag or id) makes patches apply retroactively across the merged group, and a compacted snapshot of one group then overrides the other group's earlier puts.
- Groups with two or more distinct dedupe tags are never compacted.

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

| Route | Request | Response |
|---|---|---|
| `GET /api/health` | | `{ ok: true }` |
| `POST /api/trips` (`Authorization: Bearer <ADMIN_SECRET>`) | `{ name, publicKey, accessTokenHash, roster, allowedSenders }` | 201 `{ id, address, domain }` (`address` is the full `slug-xxxxxx@domain`) |
| `GET /api/trips/:id` | | `TripMeta` |
| `PATCH /api/trips/:id` | `{ name?, roster?, allowedSenders? }` | `TripMeta` |
| `GET /api/trips/:id/records?since=N` | | `{ records: StoredRecord[], latestSeq: number, more: boolean }` (seq > N, ascending; paged, see below) |
| `POST /api/trips/:id/records` | `{ ciphertext, dedupe? }` | 201 `{ seq }` |
| `DELETE /api/trips/:id/records/:seq` | | 204 |
| `PUT /api/trips/:id/blobs/:blobId` | raw bytes, `application/octet-stream` | 201 |
| `GET /api/trips/:id/blobs/:blobId` | | raw bytes |
| `GET /api/trips/:id/geocode?q=` | | `{ results: Location[] }` |

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
geocode(env: Env, loc: Location): Promise<Location>
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
    skipped: number; cursor: number;
    sync(): Promise<void>; append(records: OpenedRecord[]): void; setMeta(meta: TripMeta): void }
  ```
  - `events` is `fold(records)`, recomputed once per change to `records`. `skipped` counts records that failed to open or validate (cumulative); they are never thrown. `cursor` is the server's `latestSeq`, used as `since` on the next fetch.
  - Errors: missing or invalid fragment gives `bad-link` ("This link is missing its key"); 401/403/404 gives `unauthorized` ("Trip not found or wrong key"); records present but none opening gives terminal `undecryptable`; network, 429 or 5xx gives `network`; a paging response that promises more but makes no progress gives `unknown`. `hashchange` to a different secret replaces the store (`onReplace`); removing the fragment keeps the current keys. A failed initial load sets `status: 'error'` and retries with backoff (2s, 5s, 15s, then 30s). A network failure during sync keeps `status: 'ready'` and the last data and sets `error` to the `network` error; the next success clears it. A 401 during sync is fatal (`status: 'error'`).
  - `append(opened)`: for the write path; merges already-opened records by `seq` (duplicates ignored) and re-folds. It does not advance `cursor`, so the next sync still fetches records written by others in between. `setMeta` replaces `meta` after a PATCH.
  - Sync: `since=cursor`, paging while `more`; triggered on window focus, on visibilitychange to visible, and every 60 s while the page is visible. Concurrent calls share one request.
  - `createTripStore({ tripId, fragment, api?, intervalMs?, backoffMs? })` builds a store without React (for tests and caching); `openRecords(privateKey, stored)` is also exported.
  - `trip/actions.ts` adds `putEvent(e)`, `patchEvent(id, fields)`, `deleteEvent(id)`.
- **`trip/attachments.ts`:** `fetchAttachment(a: Attachment): Promise<Blob>` (fetch, open, wrap with `a.mime`); `uploadAttachment(file: File): Promise<Attachment>`.
- **`filters/filter.ts`:** `type Filter`, `filterEvents(events, filter)`, `useFilter()`, `useFilteredEvents()`.
- **`event/EventSheet.tsx`:** mounted once in the shell; open an event by setting query key `e`. Views never render their own detail UI.
- **`timeline/scale.ts`:** `type TimeScale = { pxPerHour: number; originMs: number; toY(ms: number): number; toMs(y: number): number }`, `makeScale(originMs, pxPerHour)`, and `useTimeScale()` from a context provided by `Timeline`. Anything drawn beside the axis (weather) positions itself with this and nothing else.
- **`timeline/layout.ts`:** `layoutEvents(events, scale, lanes: { mode: 'none'|'type'|'participant'; roster: readonly RosterMember[] }): { lanes: { key, label }[]; blocks: { eventId, laneKey, top, height, column, columns }[]; unscheduled: Event[] }` — pure, unit-tested. Also `ticks(scale, fromMs, toMs, tz): { ms, label, kind: 'hour'|'day'|'week' }[]` (scale.ts) and `initialScrollMs(events, nowMs)` (layout.ts). Exported from scale.ts: `MIN_PX_PER_HOUR` (1), `MAX_PX_PER_HOUR` (240) and tick thresholds (hour >= 30 px/h, day >= 4, else week). Participant mode adds an `_other` lane for ids not in the roster.
- **`weather/`:** `resolve.ts` `hourlyLocations(events, fromMs, toMs): WeatherSegment[]` (`{ fromMs, toMs, lat, lng, label }`, per-hour place merged, lat/lng rounded to 2 dp). `openMeteo.ts` `fetchHourly(segment, { nowMs?, fetchFn?, signal? }): Promise<HourlySeries>` (`{ timeMs[], tempC[], windKph[], precipMm[] }`, UTC instants; empty series outside today..today+15 days; 30-minute in-memory cache; rejects on HTTP/network error), `clearWeatherCache()`. `useWeather(fromMs, toMs): { series: { segment, series }[]; status: 'idle'|'loading'|'ready'|'error' }`. `units.ts`: `defaultUnits(locale?)`, `convertTemp`, `convertWind`, `formatTemp`, `formatWind`, `formatPrecip`.
- **Time display:** blocks are positioned by absolute instant. The axis is labelled in one display zone (query key `tz`, default the browser's zone); each event's own local times are shown in its label and sheet.

## 8. Config

Worker bindings and vars (`src/env.ts`): `DB` (D1), `BLOBS` (R2), `ASSETS` (static assets), `TRIP_DOMAIN`, `ADMIN_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`. Local values in `packages/worker/.dev.vars` (gitignored); commit `.dev.vars.example`. Web: `VITE_GOOGLE_MAPS_KEY` in `packages/web/.env.local` (gitignored); commit `.env.example`. Code must run with the two API keys unset: geocoding returns no coordinates, the map shows a "key not configured" notice, and LLM tests use a mocked client.

## 9. Commands

From the repo root: `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm dev` (Worker on :8787 and Vite on :5173 with `/api` proxied), `pnpm seed` (prints a trip URL for the local Worker). Per package: `pnpm --filter @planfully/<shared|worker|web> <script>`.
