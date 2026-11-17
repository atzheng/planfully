// `pnpm seed`: create a sample trip on a running local Worker through the HTTP API.
//
//   pnpm seed [--url http://localhost:8787] [--web http://localhost:5173]
//
// ADMIN_SECRET comes from the environment, else packages/worker/.dev.vars, else
// .dev.vars.example (the dev default). Everything stored is sealed here; the server only
// sees ciphertext. The trip secret appears only in the printed URL fragment.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OpenedRecordSchema,
  RecordBodySchema,
  deriveTripKeys,
  encodeSecret,
  fold,
  fromBase64,
  generateSecret,
  hashAccessToken,
  openJson,
  open,
  seal,
  sealJson,
  toBase64,
  toBase64Url,
  type Event,
  type OpenedRecord,
  type StoredRecord,
} from '@planfully/shared';
import { buildSampleTrip } from './sampleTrip';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !v) fail(`--${name} needs a value`);
  return (v ?? fallback).replace(/\/+$/, '');
}

function fail(msg: string): never {
  console.error(`seed: ${msg}`);
  process.exit(1);
}

function readAdminSecret(): string {
  if (process.env['ADMIN_SECRET']) return process.env['ADMIN_SECRET'];
  const dir = new URL('../', import.meta.url);
  for (const file of ['.dev.vars', '.dev.vars.example']) {
    const path = fileURLToPath(new URL(file, dir));
    if (!existsSync(path)) continue;
    const m = /^ADMIN_SECRET=(.*)$/m.exec(readFileSync(path, 'utf8'));
    if (m?.[1]) {
      if (file !== '.dev.vars') {
        console.warn(`seed: packages/worker/.dev.vars not found; using ADMIN_SECRET from ${file}`);
      }
      return m[1].trim();
    }
  }
  return fail('no ADMIN_SECRET (set it in the environment or packages/worker/.dev.vars)');
}

const api = arg('url', 'http://localhost:8787');
const web = arg('web', 'http://localhost:5173');

async function call(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(api + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  } catch {
    return fail(`cannot reach the Worker at ${api}; is \`pnpm dev\` running?`);
  }
  if (!res.ok) {
    return fail(
      `${init.method ?? 'GET'} ${path.replace(/^\/api\/trips\/[^/]+/, '')}: ${res.status} ${await res.text()}`,
    );
  }
  return res;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function downloadRecords(tripPath: string, token: string): Promise<StoredRecord[]> {
  const all: StoredRecord[] = [];
  let since = 0;
  for (;;) {
    const res = await call(`${tripPath}/records?since=${since}`, token);
    const page = (await res.json()) as {
      records: StoredRecord[];
      latestSeq: number;
      more: boolean;
    };
    all.push(...page.records);
    if (!page.more) return all;
    since = page.latestSeq;
  }
}

function check(ok: boolean, what: string, problems: string[]): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
}

async function main(): Promise<void> {
  const adminSecret = readAdminSecret();
  const sample = buildSampleTrip();

  const secret = generateSecret();
  const keys = await deriveTripKeys(secret);

  const created = await call(
    '/api/trips',
    adminSecret,
    json({
      name: sample.name,
      publicKey: toBase64Url(keys.publicKey),
      accessTokenHash: await hashAccessToken(keys.accessToken),
      roster: sample.roster,
      allowedSenders: ['sample@example.com'],
    }),
  );
  const { id, address } = (await created.json()) as { id: string; address: string };
  const tripPath = `/api/trips/${encodeURIComponent(id)}`;
  const token = keys.accessToken;

  for (const a of sample.attachments) {
    const sealed = await seal(keys.publicKey, a.bytes);
    await call(`${tripPath}/blobs/${a.id}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sealed,
    });
  }
  for (const r of sample.records) {
    const ciphertext = toBase64(await sealJson(keys.publicKey, r.body));
    await call(
      `${tripPath}/records`,
      token,
      json({ ciphertext, ...(r.dedupe ? { dedupe: r.dedupe } : {}) }),
    );
  }

  // --- self-check: download, open, fold, assert -----------------------------------------
  console.log(
    `self-check (trip ${id}, ${sample.records.length} records, ${sample.attachments.length} blobs)`,
  );
  const problems: string[] = [];
  const stored = await downloadRecords(tripPath, token);
  const opened: OpenedRecord[] = [];
  for (const r of stored) {
    const body = RecordBodySchema.parse(await openJson(keys.privateKey, fromBase64(r.ciphertext)));
    opened.push(
      OpenedRecordSchema.parse({ seq: r.seq, dedupe: r.dedupe, createdAt: r.createdAt, body }),
    );
  }
  check(
    opened.length === sample.records.length,
    `all ${sample.records.length} records open (${opened.length})`,
    problems,
  );

  const events: Event[] = fold(opened);
  const e = sample.expected;
  check(events.length === e.count, `folds to ${e.count} events (${events.length})`, problems);
  check(
    !events.some((ev) => ev.name === e.deletedName),
    `deleted "${e.deletedName}" is gone`,
    problems,
  );

  const dups = events.filter((ev) => ev.name === e.duplicate.name);
  check(
    dups.length === 1 && dups[0]?.start?.local === e.duplicate.start.local,
    `"${e.duplicate.name}" sent ${e.duplicate.puts}x merged to one event at the later time`,
    problems,
  );
  const patched = events.find((ev) => ev.name === e.patched.name);
  check(
    patched?.start?.local === e.patched.start.local && patched.notes === e.patched.notes,
    `patch applied to "${e.patched.name}"`,
    problems,
  );
  check(
    events.filter((ev) => !ev.start).length === e.unscheduled,
    `${e.unscheduled} unscheduled events`,
    problems,
  );
  check(
    new Set(events.map((ev) => ev.start?.tz).filter(Boolean)).size >= 2,
    'at least two time zones',
    problems,
  );

  for (const a of sample.attachments) {
    const res = await call(`${tripPath}/blobs/${a.id}`, token);
    const bytes = await open(keys.privateKey, new Uint8Array(await res.arrayBuffer()));
    check(
      bytes.length === a.size && bytes.every((b, i) => b === a.bytes[i]),
      `blob ${a.filename} downloads and opens (${a.size} bytes)`,
      problems,
    );
  }

  if (problems.length > 0) fail(`self-check failed: ${problems.join('; ')}`);

  console.log(`\ntrip address: ${address}`);
  console.log(`${web}/t/${id}#${encodeSecret(secret)}`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
