// Pure helpers for the settings screen: validation and roster/sender edits.

import type { Event, RosterMember } from '@planfully/shared';

export const MAX_ROSTER = 50;
export const MAX_SENDERS = 100;
export const MAX_NAME = 200;
export const MAX_SENDER_LEN = 320;

// Deliberately loose: one @, no whitespace, a dot in the domain.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>.]+(\.[^\s@,;<>.]+)+$/;

export function isValidEmail(s: string): boolean {
  return s.length <= MAX_SENDER_LEN && EMAIL_RE.test(s);
}

export type SenderResult = { ok: true; senders: string[] } | { ok: false; error: string };

/** Adds an address (trimmed, lowercased). Duplicates are a no-op. */
export function addSender(senders: readonly string[], input: string): SenderResult {
  const email = input.trim().toLowerCase();
  if (!email) return { ok: false, error: 'Enter an email address.' };
  if (!isValidEmail(email)) return { ok: false, error: `"${email}" is not a valid email address.` };
  if (senders.includes(email)) return { ok: true, senders: [...senders] };
  if (senders.length >= MAX_SENDERS)
    return { ok: false, error: `At most ${MAX_SENDERS} allowed senders.` };
  return { ok: true, senders: [...senders, email] };
}

export function removeSender(senders: readonly string[], email: string): string[] {
  return senders.filter((s) => s !== email);
}

export function parseAliases(s: string): string[] {
  return [
    ...new Set(
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export function formatAliases(aliases: readonly string[]): string {
  return aliases.join(', ');
}

export function addMember(
  roster: readonly RosterMember[],
  name: string,
  newId: () => string,
): { ok: true; roster: RosterMember[] } | { ok: false; error: string } {
  const n = name.trim();
  if (!n) return { ok: false, error: 'Enter a name.' };
  if (n.length > MAX_NAME) return { ok: false, error: `Names are at most ${MAX_NAME} characters.` };
  if (roster.length >= MAX_ROSTER) return { ok: false, error: `At most ${MAX_ROSTER} travellers.` };
  return { ok: true, roster: [...roster, { id: newId(), name: n, aliases: [] }] };
}

/** Edits a member in place. The id never changes. */
export function updateMember(
  roster: readonly RosterMember[],
  id: string,
  fields: { name?: string; aliases?: string[] },
): RosterMember[] {
  return roster.map((m) => (m.id === id ? { ...m, ...fields, id: m.id } : m));
}

export function removeMember(roster: readonly RosterMember[], id: string): RosterMember[] {
  return roster.filter((m) => m.id !== id);
}

/** Number of live events that name this member as a participant. */
export function countReferences(events: readonly Event[], id: string): number {
  return events.filter((e) => !e.deleted && e.participants.includes(id)).length;
}

/** First problem with a roster draft, or null. Names must be non-empty. */
export function rosterError(roster: readonly RosterMember[]): string | null {
  if (roster.some((m) => m.name.trim() === '')) return 'Every traveller needs a name.';
  if (roster.some((m) => m.name.trim().length > MAX_NAME))
    return `Names are at most ${MAX_NAME} characters.`;
  return null;
}

/** Trims names before saving. */
export function cleanRoster(roster: readonly RosterMember[]): RosterMember[] {
  return roster.map((m) => ({ ...m, name: m.name.trim() }));
}
