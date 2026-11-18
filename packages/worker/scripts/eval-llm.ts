// Opt-in evaluation of the LLM parser against the real Anthropic API. NOT part of `pnpm test`.
//
//   pnpm --filter @planfully/worker eval [--only name[,name]] [--runs N]
//
// Runs parseEmail on every test/fixtures/emails/parse/<case>.eml and compares the result with
// <case>.expected.json. ANTHROPIC_API_KEY comes from the environment, else packages/worker/.dev.vars.
// Costs real money (about a cent per run of the whole corpus). The key is never printed.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { RosterMember } from '@planfully/shared';
import PostalMime from 'postal-mime';
import type { ParsedEmail } from '../src/email/types';
import { PARSE_MODEL, ParseError, parseEmailDetailed, type LlmClient } from '../src/llm/parse';

const roster: RosterMember[] = [
  { id: 'alice', name: 'Alice Smith', aliases: ['SMITH/ALICE MS'] },
  { id: 'bob', name: 'Bob Jones', aliases: ['JONES/BOB MR'] },
];

// $ per million tokens for claude-haiku-5-5 (prompts up to 100K tokens).
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;

type ExpectedTime = { local: string; tz: string };
type ExpectedEvent = {
  type: string;
  /** Loose: every word of this must appear in the actual name (case and accents ignored). */
  name?: string;
  start?: ExpectedTime;
  end?: ExpectedTime;
  confirmation?: string;
  /** Loose, compared with location.name. A 3-capital-letter value is an IATA code and must appear as "(XXX)". */
  location?: string;
  endLocation?: string;
  participants?: string[];
  status?: string;
  attachmentIndexes?: number[];
};
type Expected = { events: ExpectedEvent[] };

const dir = fileURLToPath(new URL('../test/fixtures/emails/parse/', import.meta.url));

function apiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];
  const path = fileURLToPath(new URL('../.dev.vars', import.meta.url));
  if (existsSync(path)) {
    const m = /^ANTHROPIC_API_KEY=(.*)$/m.exec(readFileSync(path, 'utf8'));
    const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v) return v;
  }
  console.error('eval: no ANTHROPIC_API_KEY (environment or packages/worker/.dev.vars)');
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function load(name: string): Promise<{ email: ParsedEmail; expected: Expected }> {
  const raw = readFileSync(`${dir}${name}.eml`);
  const p = await PostalMime.parse(raw);
  const email: ParsedEmail = {
    from: p.from?.address ?? '',
    to: 'trip@trips.example.com',
    suffix: '',
    subject: p.subject ?? '',
    date: p.date ?? '',
    text: p.text,
    html: p.html,
    attachments: p.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      mime: a.mimeType,
      bytes: new Uint8Array(a.content as ArrayBuffer),
    })),
    sourceAttachment: {
      id: 'src',
      filename: 'mail.eml',
      mime: 'message/rfc822',
      size: raw.length,
      kind: 'source-email',
    },
  };
  const expected = JSON.parse(readFileSync(`${dir}${name}.expected.json`, 'utf8')) as Expected;
  return { email, expected };
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function looseContains(actual: string | undefined, want: string): boolean {
  if (!want) return true;
  if (!actual) return false;
  if (/^[A-Z]{3}$/.test(want)) return actual.includes(`(${want})`);
  const a = norm(actual);
  return norm(want)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((w) => a.includes(w));
}

type Actual = Awaited<ReturnType<typeof parseEmailDetailed>>['events'][number];

function compareEvent(want: ExpectedEvent, got: Actual): string[] {
  const bad: string[] = [];
  if (want.name && !looseContains(got.name, want.name)) bad.push(`name "${got.name}"`);
  for (const k of ['start', 'end'] as const) {
    const w = want[k];
    if (!w) continue;
    const g = got[k];
    if (g?.local !== w.local || g?.tz !== w.tz)
      bad.push(`${k} ${g ? `${g.local} ${g.tz}` : 'missing'} (want ${w.local} ${w.tz})`);
  }
  if (want.confirmation && norm(got.confirmation ?? '') !== norm(want.confirmation))
    bad.push(`confirmation "${got.confirmation ?? ''}"`);
  for (const k of ['location', 'endLocation'] as const) {
    const w = want[k];
    if (w && !looseContains(got[k]?.name, w)) bad.push(`${k} "${got[k]?.name ?? ''}" (want ~${w})`);
  }
  if (want.participants) {
    const g = [...got.participants].sort().join(',');
    if (g !== [...want.participants].sort().join(',')) bad.push(`participants [${g}]`);
  }
  if (want.status && got.status !== want.status) bad.push(`status ${got.status}`);
  if (want.attachmentIndexes) {
    const g = [...got.attachmentIndexes].sort().join(',');
    if (g !== [...want.attachmentIndexes].sort().join(',')) bad.push(`attachmentIndexes [${g}]`);
  }
  return bad;
}

function compare(expected: Expected, actual: Actual[]): string[] {
  const problems: string[] = [];
  if (expected.events.length !== actual.length)
    problems.push(`event count ${actual.length} (want ${expected.events.length})`);
  const used = new Set<number>();
  for (const want of expected.events) {
    // Pair by type and start time (or, with no start, by type alone), then report differences.
    let idx = actual.findIndex(
      (a, i) => !used.has(i) && a.type === want.type && a.start?.local === want.start?.local,
    );
    if (idx < 0) idx = actual.findIndex((a, i) => !used.has(i) && a.type === want.type);
    if (idx < 0) {
      problems.push(`no ${want.type} event for ${want.name ?? want.start?.local ?? '?'}`);
      continue;
    }
    used.add(idx);
    const got = actual[idx];
    if (got)
      for (const b of compareEvent(want, got)) problems.push(`[${want.name || want.type}] ${b}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const key = apiKey();
  const only = arg('only')?.split(',');
  const runs = Number(arg('runs') ?? '1');
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.eml'))
    .map((f) => f.slice(0, -4))
    .filter((n) => !only || only.includes(n))
    .sort();

  const real = new Anthropic({ apiKey: key });
  let failures = 0;
  for (let run = 1; run <= runs; run++) {
    console.log(`\nRun ${run}/${runs} (model ${PARSE_MODEL})`);
    console.log(
      'case'.padEnd(20),
      'result'.padEnd(7),
      'in'.padStart(7),
      'out'.padStart(6),
      'cost$'.padStart(8),
    );
    let totalCost = 0;
    for (const name of names) {
      const { email, expected } = await load(name);
      let tin = 0;
      let tout = 0;
      const client: LlmClient = {
        messages: {
          create: async (body) => {
            const msg = await real.messages.create(body);
            tin += msg.usage.input_tokens;
            tout += msg.usage.output_tokens;
            return msg;
          },
        },
      };
      let problems: string[];
      try {
        const today = (email.date ? new Date(email.date) : new Date()).toISOString().slice(0, 10);
        const { events, dropped } = await parseEmailDetailed(email, {
          roster,
          today,
          apiKey: key,
          client,
        });
        problems = compare(expected, events);
        if (dropped) problems.push(`${dropped} invalid event(s) dropped`);
      } catch (err) {
        problems = [
          err instanceof ParseError
            ? `ParseError ${err.reason}: ${err.message}`
            : `error ${String(err instanceof Error ? err.name : err)}`,
        ];
      }
      const cost = (tin * PRICE_IN + tout * PRICE_OUT) / 1e6;
      totalCost += cost;
      if (problems.length) failures++;
      console.log(
        name.padEnd(20),
        (problems.length ? 'FAIL' : 'pass').padEnd(7),
        String(tin).padStart(7),
        String(tout).padStart(6),
        cost.toFixed(5).padStart(8),
      );
      for (const p of problems) console.log(`    - ${p}`);
    }
    console.log(
      `total ${totalCost.toFixed(5)} USD, ${(totalCost / names.length).toFixed(5)} per email`,
    );
  }
  console.log(failures ? `\n${failures} failing case(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

void main();
