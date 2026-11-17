# Planfully spec

A trip tracker: forward booking emails to a per-trip address, an LLM turns them into events, and a web app shows them on a timeline and a map. Stored trip data is encrypted to a key that only exists in the trip URL.

## 1. Decisions

| Area | Decision |
|---|---|
| Platform | Cloudflare: Email Routing -> Worker, D1 (trip metadata + sealed event records), R2 (sealed attachments and raw emails), static assets served by the same Worker |
| Trust model | Encrypt at rest. The Worker sees an email transiently, parses it, encrypts the result to the trip public key and discards the plaintext |
| LLM | Claude Haiku 5.5 (`claude-haiku-5-5`), structured output, PDFs and images passed natively |
| Inbound senders | Per-trip allowlist; everything else is dropped before any LLM call |
| Trip creation | Admin only (admin secret held by the owner) |
| Sharing | One full-access link per trip (view + edit) |
| Participants | Per-trip roster; the LLM maps names in emails onto it |
| Rebooked/duplicate emails | Auto-merge on type + confirmation number; cancellations mark the event cancelled |
| Web edits | Edit/delete events, add events manually, upload files directly |
| Maps | Google Maps JS API, Google Geocoding/Places |
| Weather | Open-Meteo hourly forecast (no key) |
| Mobile | Installable PWA with offline access, `.ics` export, current-location dot |
| Domain | Not yet purchased; a config value (`TRIP_DOMAIN`) |

## 2. Data model

### Trip (D1, plaintext — the Worker needs it to route and parse)

- `id` — random, appears in the URL path
- `address` — the full lowercase trip email address, `<slug>-<6 random chars>@<TRIP_DOMAIN>` (not just the local part)
- `public_key` — X25519
- `access_token_hash` — SHA-256 of the access token derived from the URL secret
- `dedupe_key` — per-trip random HMAC key, server-side only
- `allowed_senders` — list of email addresses
- `roster` — list of `{id, name, aliases[]}`
- `name`, `created_at`

### Event (encrypted)

All fields except `id`, `name` and `type` are optional.

```ts
type Event = {
  id: string
  name: string
  type: 'flight' | 'train' | 'bus' | 'ferry' | 'car' | 'lodging' | 'dining'
      | 'activity' | 'attraction' | 'receipt' | 'other'
  start?: { local: string; tz: string }   // ISO local time + IANA zone
  end?:   { local: string; tz: string }
  confirmation?: string
  location?:    { name?: string; address?: string; lat?: number; lng?: number; placeId?: string }
  endLocation?: Location                  // arrival point for transport
  attachments: { id: string; filename: string; mime: string; size: number }[]
  participants: string[]                  // roster ids; empty = everyone
  status: 'confirmed' | 'cancelled'
  notes?: string
  source: 'email' | 'manual'
}
```

Times are stored as local time plus zone so a flight shows departure and arrival in their own zones. Unscheduled events (landmarks) have no `start` and appear only on the map and in an "unscheduled" list.

## 3. Keys and the trip URL

`https://<app>/t/<tripId>#<secret>`

- `secret` is 32 random bytes generated in the browser when the trip is created. It lives in the URL fragment, which browsers never send to the server.
- From `secret`, via HKDF:
  - the X25519 **private key** (public key is uploaded at creation)
  - an **access token**, sent as a bearer token on every API call; the server stores only its hash
- Records are sealed to the public key (ephemeral X25519 + HKDF + AES-256-GCM). The Worker can write but never read back.
- Attachments are encrypted the same way, one R2 object each.

Losing the URL loses the trip. There is no recovery.

## 4. Storage: append-only encrypted log

Because the Worker cannot decrypt, it cannot update an event in place. Each trip is a log of sealed records, one D1 row each: `(trip_id, seq, dedupe, ciphertext, created_at)`. `seq` is a per-trip counter, so the browser syncs with "everything after seq N". Attachments and raw emails are too large for rows and live in R2. Record kinds (inside the ciphertext):

- `put` — full event, tagged with `dedupe = HMAC(dedupe_key, type + confirmation)` when a confirmation number exists
- `patch` / `delete` — written by the browser when someone edits

The original email (`.eml`) is stored as a sealed blob and listed as a `source-email` attachment on the events it produced.

The browser decrypts the log and folds it: records sharing a `dedupe` tag merge into one event (newer fields win, attachments union, `cancelled` sticks, fields edited by hand are not overwritten by later emails). The browser may compact the log by writing one merged record and deleting the ones it replaces. Exact rules are in `CONTRACTS.md` section 3.

## 5. Email ingest

1. Mail arrives at `<address>[+suffix]@TRIP_DOMAIN`. Unknown address -> reject.
2. Sender must be on the allowlist and pass SPF or DKIM. Otherwise drop silently.
3. Seal and store the raw email first, so a parsing failure never loses it.
4. Route on suffix:
   - **none** — send body + attachments + roster to the LLM, which returns `Event[]`. Geocode each location. Seal and append each event.
   - **`+receipts`** — no LLM call. One event with `type: 'receipt'`, `name` = subject, attachments = the email's files (or the email itself if it has none).
5. If parsing fails or returns nothing, append an `other` event named after the subject with the raw email attached, flagged "needs review".

Limits: 25 MB per email (Cloudflare's cap).

CPU budget: the Workers free plan allows about 10 ms of CPU per invocation. Keep ingest cheap — bulk encryption through native WebCrypto AES-GCM (the `@noble` code only does the 32-byte key agreement), and no re-encoding of attachments beyond what the LLM call requires. Measure real emails on the free plan before deciding whether the paid plan is needed.

## 6. API (Worker)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/trips` | admin secret | create trip: name, public key, access-token hash, roster, allowlist |
| `GET /api/trips/:id` | access token | metadata: name, address, roster, allowlist |
| `PATCH /api/trips/:id` | access token | edit roster and allowlist |
| `GET /api/trips/:id/records?since=` | access token | sealed records |
| `POST /api/trips/:id/records` | access token | append a sealed record (edits, manual events) |
| `DELETE /api/trips/:id/records/:rid` | access token | compaction |
| `GET/PUT /api/trips/:id/blobs/:bid` | access token | sealed attachments |
| `GET /api/trips/:id/geocode` | access token | proxy to Google Geocoding for manual events |

Request and response shapes are in `CONTRACTS.md` section 5.

## 7. Web app

React + TypeScript + Vite, one responsive app for desktop and phone.

**Shared**
- Filter bar on both views: name search, type, start/end range, participant. Filter state lives in the URL query so it survives reloads.
- Event sheet on click: all fields, attachment links (decrypted in the browser on open), edit, delete.
- Add event, upload file, trip settings (roster, allowed senders, trip address).
- Export: PDF and `.ics` of the currently filtered events, both generated in the browser.

**Timeline**
- Vertical time axis; opens scrolled to today (or the trip's first day if today is outside it).
- Zoom from hours to weeks (pinch, ctrl-scroll, buttons).
- Lanes: single, split by type, or split by participant — side-by-side columns.
- Weather strip alongside the axis, toggleable: hourly temperature, wind, rain. Location for each hour is taken from the event in progress or the most recent one. Forecasts only exist ~16 days ahead; later dates show nothing.
- Cancelled events are struck through and hidden by default.

**Map**
- A pin for every event with coordinates, coloured by type; transport draws a line from start to end location.
- Same event sheet on click. Current-location dot on request.

**Offline (PWA)**
- Installable. Service worker caches the app shell; the sealed log, attachments and the trip secret are kept in IndexedDB so the trip opens with no signal.
- Edits made offline queue and sync on reconnect.

**PDF**
- Day-by-day itinerary: time, name, type, confirmation, location, participants. Attachments listed by filename, not embedded.

## 8. What third parties see

- **Anthropic**: the content of every parsed email and its attachments.
- **Google**: addresses being geocoded, and map tile requests from the browser.
- **Open-Meteo**: coordinates and dates.
- **Cloudflare**: emails in transit; at rest, only trip name, address, roster names and allowed senders in plaintext.

## 9. Repo layout

```
packages/shared   event schema, crypto (seal/open, key derivation), log folding
packages/worker   email handler, API, LLM parsing, geocoding, D1 migrations
packages/web      React app
```

Crypto via `@noble/curves` / `@noble/hashes` so the Worker and browser share one implementation.

File paths, exported names, API shapes and library choices are fixed in `CONTRACTS.md`. Work is tracked in beads (`bd ready`).

## 10. Needed before deploy

- A domain on Cloudflare DNS with Email Routing enabled
- Cloudflare account (Workers, R2, D1)
- Anthropic API key
- Google Maps key (Maps JS, Geocoding, Places), billing enabled
- An admin secret

## 11. Build order

1. `shared`: schema, crypto, log folding, with tests
2. Worker: trip creation, records/blobs API, local dev with Miniflare
3. Web: trip creation, decrypt, timeline, event sheet, filters
4. Email ingest + LLM parsing, tested against sample emails
5. Map view, geocoding
6. Weather strip
7. Edits, manual events, uploads
8. PDF, `.ics`
9. PWA/offline
10. Deploy docs
