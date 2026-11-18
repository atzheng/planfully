import { useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { RosterMember, TripMeta } from '@planfully/shared';
import { newMemberId, tripEmails } from '../create/CreateTrip';
import { ApiError, patchTrip } from '../lib/api';
import { ArrowLeft } from 'lucide-react';
import pages from '../pages/pages.module.css';
import { ThemeToggle } from '../theme/ThemeToggle';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  addMember,
  addSender,
  cleanRoster,
  countReferences,
  formatAliases,
  parseAliases,
  removeMember,
  removeSender,
  rosterError,
  updateMember,
} from './logic';
import styles from './Settings.module.css';

function BackHeader({ to }: { to: { pathname: string; hash: string } }) {
  return (
    <header className={pages.header}>
      <Link to={to} className={styles.back}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to trip
      </Link>
      <div className={pages.headerActions}>
        <ThemeToggle />
      </div>
    </header>
  );
}

function CopyRow({ label, value, help }: { label: string; value: string; help: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  return (
    <div className={styles.copyRow}>
      <div className={styles.copyText}>
        <span className={styles.label}>{label}</span>
        <code className={styles.code}>{value}</code>
        <span className={styles.hint}>{help}</span>
        {state === 'failed' && (
          <span role="alert" className={styles.error}>
            Could not copy automatically. Select the address and copy it by hand.
          </span>
        )}
      </div>
      <Button size="sm" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function AliasField({
  name,
  value,
  onCommit,
}: {
  name: string;
  value: readonly string[];
  onCommit: (aliases: string[]) => void;
}) {
  const [text, setText] = useState(formatAliases(value));
  return (
    <Input
      aria-label={`Aliases for ${name}`}
      placeholder="Aliases, comma separated"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(parseAliases(e.target.value));
      }}
    />
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function SettingsForm({ meta }: { meta: TripMeta }) {
  const { tripId = '' } = useParams();
  const { hash } = useLocation();
  const accessToken = useTrip((s) => s.keys?.accessToken);
  const events = useTrip((s) => s.events);
  const setMeta = useTrip((s) => s.setMeta);

  const [roster, setRoster] = useState<RosterMember[]>(meta.roster);
  const [senders, setSenders] = useState<string[]>(meta.allowedSenders);
  const [newName, setNewName] = useState('');
  const [newSender, setNewSender] = useState('');
  const [rosterMsg, setRosterMsg] = useState<string | null>(null);
  const [senderMsg, setSenderMsg] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = !sameJson(roster, meta.roster) || !sameJson(senders, meta.allowedSenders);
  const { email, receipts } = tripEmails(meta.address, meta.domain);
  const back = { pathname: `/t/${encodeURIComponent(tripId)}`, hash };

  function onAddMember(e: FormEvent) {
    e.preventDefault();
    const r = addMember(roster, newName, newMemberId);
    if (!r.ok) return setRosterMsg(r.error);
    setRoster(r.roster);
    setNewName('');
    setRosterMsg(null);
    setSaveMsg(null);
  }

  function onAddSender(e: FormEvent) {
    e.preventDefault();
    const r = addSender(senders, newSender);
    if (!r.ok) return setSenderMsg(r.error);
    setSenders(r.senders);
    setNewSender('');
    setSenderMsg(null);
    setSaveMsg(null);
  }

  function onRemoveMember(id: string) {
    if (countReferences(events, id) > 0 && confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setRoster(removeMember(roster, id));
    setConfirmId(null);
    setSaveMsg(null);
  }

  async function save() {
    const problem = rosterError(roster);
    if (problem) return setSaveMsg({ ok: false, text: problem });
    if (!accessToken) return setSaveMsg({ ok: false, text: 'The trip is not loaded yet.' });
    setBusy(true);
    setSaveMsg(null);
    try {
      const updated = await patchTrip(
        { tripId, accessToken },
        { roster: cleanRoster(roster), allowedSenders: senders },
      );
      setMeta(updated);
      setRoster(updated.roster);
      setSenders(updated.allowedSenders);
      setSaveMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setSaveMsg({
        ok: false,
        text:
          err instanceof ApiError
            ? `The server rejected the change: ${err.message}`
            : 'Could not reach the server. Your edits are still here; try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BackHeader to={back} />
      <div className={styles.page}>
        <h1 className={styles.h1}>Trip settings</h1>

        <section className={styles.section} aria-labelledby="trip-h">
          <h2 id="trip-h" className={styles.h2}>
            Trip
          </h2>
          <div className={styles.row}>
            <span className={styles.label}>Name</span>
            <span>{meta.name}</span>
          </div>
          <p className={styles.note}>
            The link to this trip is the only key. Anyone who has it can read the trip, and it
            cannot be recovered if lost.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="roster-h">
          <h2 id="roster-h" className={styles.h2}>
            Travellers
          </h2>
          <ul className={styles.list}>
            {roster.map((m) => {
              const refs = countReferences(events, m.id);
              return (
                <li key={m.id} className={styles.member}>
                  <Input
                    aria-label={`Name of ${m.name || 'traveller'}`}
                    value={m.name}
                    onChange={(e) =>
                      setRoster(updateMember(roster, m.id, { name: e.target.value }))
                    }
                  />
                  <AliasField
                    name={m.name}
                    value={m.aliases}
                    onCommit={(aliases) => setRoster((r) => updateMember(r, m.id, { aliases }))}
                  />
                  {confirmId === m.id ? (
                    <div className={styles.confirm} role="alert">
                      <span>
                        {refs} {refs === 1 ? 'event refers' : 'events refer'} to {m.name}. They will
                        show &ldquo;Former participant&rdquo;.
                      </span>
                      <Button variant="danger" onClick={() => onRemoveMember(m.id)}>
                        Remove anyway
                      </Button>
                      <Button onClick={() => setConfirmId(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      className={styles.remove}
                      aria-label={`Remove ${m.name || 'traveller'}`}
                      onClick={() => onRemoveMember(m.id)}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
            {roster.length === 0 && <li className={styles.hint}>No travellers yet.</li>}
          </ul>
          <form className={styles.addRow} onSubmit={onAddMember}>
            <Input
              aria-label="New traveller name"
              placeholder="New traveller"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit">Add</Button>
          </form>
          {rosterMsg && (
            <p role="alert" className={styles.error}>
              {rosterMsg}
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="senders-h">
          <h2 id="senders-h" className={styles.h2}>
            Allowed senders
          </h2>
          <p className={styles.hint}>
            Only mail from these addresses is accepted at the trip address.
          </p>
          <ul className={styles.list}>
            {senders.map((s) => (
              <li key={s} className={styles.sender}>
                <span className={styles.senderText}>{s}</span>
                <Button
                  variant="ghost"
                  className={styles.remove}
                  aria-label={`Remove ${s}`}
                  onClick={() => {
                    setSenders(removeSender(senders, s));
                    setSaveMsg(null);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
            {senders.length === 0 && <li className={styles.hint}>No allowed senders yet.</li>}
          </ul>
          <form className={styles.addRow} onSubmit={onAddSender} noValidate>
            <Input
              type="email"
              inputMode="email"
              aria-label="New allowed sender"
              placeholder="name@example.com"
              value={newSender}
              onChange={(e) => setNewSender(e.target.value)}
            />
            <Button type="submit">Add</Button>
          </form>
          {senderMsg && (
            <p role="alert" className={styles.error}>
              {senderMsg}
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="addr-h">
          <h2 id="addr-h" className={styles.h2}>
            Trip email address
          </h2>
          <CopyRow
            label="Trip address"
            value={email}
            help="Forward bookings here. They are parsed into events."
          />
          <CopyRow
            label="Receipts address"
            value={receipts}
            help="Forward receipts here. They are filed as receipts without parsing."
          />
        </section>

        <p className={styles.hint}>
          Traveller names and allowed senders are stored unencrypted on the server, because it needs
          them to route and parse email.
        </p>

        <div className={styles.saveBar}>
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving...' : 'Save changes'}
          </Button>
          {saveMsg && (
            <span
              role={saveMsg.ok ? 'status' : 'alert'}
              className={saveMsg.ok ? styles.hint : styles.error}
            >
              {saveMsg.text}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

export function Settings() {
  const meta = useTrip((s) => s.meta);
  const status = useTrip((s) => s.status);
  const error = useTrip((s) => s.error);
  const { hash } = useLocation();
  const { tripId = '' } = useParams();
  const back = { pathname: `/t/${encodeURIComponent(tripId)}`, hash };
  if (status === 'error')
    return (
      <>
        <BackHeader to={back} />
        <div className={styles.page}>
          <p role="alert">{error?.message}</p>
        </div>
      </>
    );
  if (!meta)
    return (
      <>
        <BackHeader to={back} />
        <div className={styles.page}>
          <p role="status">Loading trip...</p>
        </div>
      </>
    );
  // Keyed so a replaced store (different secret) resets the drafts.
  return <SettingsForm key={meta.id} meta={meta} />;
}
