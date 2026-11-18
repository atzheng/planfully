import { useState, type FormEvent } from 'react';
import {
  deriveTripKeys,
  encodeSecret,
  generateSecret,
  hashAccessToken,
  toBase64Url,
} from '@planfully/shared';
import { ApiError, createTrip, type RosterMember } from '../lib/api';
import { ThemeToggle } from '../theme/ThemeToggle';
import { Button } from '../ui/Button';
import styles from './CreateTrip.module.css';

const MAX_ROSTER = 50;
const MAX_SENDERS = 100;
const MAX_NAME = 200;
const MAX_SENDER_LEN = 320;

export type MemberDraft = { key: number; name: string; aliases: string };

/** Short URL-safe random id (8 random bytes, base64url). */
export function newMemberId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
}

function splitList(s: string, sep: RegExp): string[] {
  return s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function buildRoster(drafts: MemberDraft[]): RosterMember[] {
  return drafts
    .map((d) => ({ name: d.name.trim(), aliases: splitList(d.aliases, /,/) }))
    .filter((d) => d.name !== '')
    .map((d) => ({ id: newMemberId(), name: d.name, aliases: d.aliases }));
}

export function parseSenders(s: string): string[] {
  return [...new Set(splitList(s, /[\s,;]+/).map((x) => x.toLowerCase()))];
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'The admin secret is wrong. Check it and try again.';
    return `The server rejected the request (${e.status}): ${e.message}`;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/** The Worker returns the full `slug-xxxxxx@domain` address; tolerate a bare local part too. */
export function tripEmails(address: string, domain: string): { email: string; receipts: string } {
  const [local, host] = address.includes('@') ? address.split('@') : [address, domain];
  return { email: `${local}@${host}`, receipts: `${local}+receipts@${host}` };
}

type Created = { url: string; email: string; receipts: string };

export function CreateTrip() {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<MemberDraft[]>([{ key: 0, name: '', aliases: '' }]);
  const [nextKey, setNextKey] = useState(1);
  const [senders, setSenders] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const roster = buildRoster(members);
    const allowedSenders = parseSenders(senders);
    if (!name.trim()) return setError('Give the trip a name.');
    if (name.trim().length > MAX_NAME)
      return setError(`The trip name must be at most ${MAX_NAME} characters.`);
    if (members.some((m) => m.name.trim() === '' && m.aliases.trim() !== ''))
      return setError('Traveller name required: a row has aliases but no name.');
    if (!adminSecret) return setError('Enter the admin secret.');
    if (roster.length > MAX_ROSTER) return setError(`At most ${MAX_ROSTER} travellers.`);
    if (allowedSenders.length > MAX_SENDERS)
      return setError(`At most ${MAX_SENDERS} allowed senders.`);
    if (allowedSenders.some((a) => a.length > MAX_SENDER_LEN))
      return setError(`Each allowed sender must be at most ${MAX_SENDER_LEN} characters.`);
    setBusy(true);
    try {
      const secret = generateSecret();
      const keys = await deriveTripKeys(secret);
      const accessTokenHash = await hashAccessToken(keys.accessToken);
      const res = await createTrip(adminSecret, {
        name: name.trim(),
        publicKey: toBase64Url(keys.publicKey),
        accessTokenHash,
        roster,
        allowedSenders,
      });
      const path = `/t/${encodeURIComponent(res.id)}`;
      setCreated({
        url: `${window.location.origin}${path}#${encodeSecret(secret)}`,
        ...tripEmails(res.address, res.domain),
      });
      setAdminSecret('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setError(null);
    } catch {
      setCopied(null);
      setError('Could not copy automatically. Select the text and copy it by hand.');
    }
  }

  if (created) {
    return (
      <main className={styles.page}>
        <h1>Trip created</h1>
        <div className={styles.warning} role="alert">
          <strong>This link is the only key to your trip.</strong> It is not stored anywhere and
          cannot be recovered. Save it now (password manager, notes) and share it only with people
          who should see the trip.
        </div>
        <section className={styles.field}>
          <span className={styles.label}>Trip link</span>
          <div className={styles.copyRow}>
            <code className={styles.value} data-testid="trip-url">
              {created.url}
            </code>
            <Button primary onClick={() => copy('url', created.url)}>
              {copied === 'url' ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </section>
        <section className={styles.field}>
          <span className={styles.label}>Forward bookings to</span>
          <div className={styles.copyRow}>
            <code className={styles.value}>{created.email}</code>
            <Button onClick={() => copy('email', created.email)}>
              {copied === 'email' ? 'Copied' : 'Copy address'}
            </Button>
          </div>
          <span className={styles.hint}>
            For receipts only, use <code>{created.receipts}</code>.
          </span>
        </section>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <a className={styles.link} href={created.url}>
          Open trip
        </a>
      </main>
    );
  }

  const setMember = (key: number, patch: Partial<MemberDraft>) =>
    setMembers((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));

  return (
    <main className={styles.page}>
      <div style={{ float: 'right' }}>
        <ThemeToggle />
      </div>
      <h1>New trip</h1>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span className={styles.label}>Trip name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Travellers</legend>
          <span className={styles.hint}>
            Aliases are other names that appear on bookings, separated by commas.
          </span>
          {members.map((m, i) => (
            <div className={styles.member} key={m.key}>
              <input
                className={styles.input}
                aria-label={`Traveller ${i + 1} name`}
                placeholder="Name"
                value={m.name}
                onChange={(e) => setMember(m.key, { name: e.target.value })}
              />
              <input
                className={styles.input}
                aria-label={`Traveller ${i + 1} aliases`}
                placeholder="Aliases (optional)"
                value={m.aliases}
                onChange={(e) => setMember(m.key, { aliases: e.target.value })}
              />
              <Button
                aria-label={`Remove traveller ${i + 1}`}
                onClick={() => setMembers((ms) => ms.filter((x) => x.key !== m.key))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              disabled={members.length >= MAX_ROSTER}
              onClick={() => {
                setMembers((ms) => [...ms, { key: nextKey, name: '', aliases: '' }]);
                setNextKey(nextKey + 1);
              }}
            >
              Add traveller
            </Button>
          </div>
        </fieldset>
        <label className={styles.field}>
          <span className={styles.label}>Allowed senders</span>
          <textarea
            className={styles.textarea}
            rows={3}
            value={senders}
            onChange={(e) => setSenders(e.target.value)}
            placeholder="you@example.com"
          />
          <span className={styles.hint}>
            Email addresses allowed to forward bookings, one per line or comma separated.
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Admin secret</span>
          <input
            className={styles.input}
            type="password"
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
            autoComplete="off"
          />
          <span className={styles.hint}>Sent once to create the trip. Never stored.</span>
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Button primary type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create trip'}
        </Button>
      </form>
    </main>
  );
}
