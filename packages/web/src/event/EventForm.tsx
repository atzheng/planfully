import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Event } from '@planfully/shared';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { PlaceSearch } from './PlaceSearch';
import {
  buildFields,
  EVENT_TYPES,
  TRANSIT_MODES,
  geoOf,
  initialValues,
  isTransport,
  timeZones,
  type EventFields,
  type FormErrors,
  type FormValues,
} from './formModel';
import styles from './EventForm.module.css';

export type EventFormProps = {
  initial?: Partial<Event>;
  /** Called with the validated, complete set of fields (callers diff if they only want changes). */
  onSubmit: (fields: EventFields) => void | Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  /** Zone for empty times when the event has none (e.g. the location's last-used zone). */
  defaultTz?: string;
};

function Field({
  label,
  error,
  id,
  children,
}: {
  label: string;
  error?: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <div id={`${id}-err`} role="alert" className={styles.error}>
          {error}
        </div>
      )}
    </div>
  );
}

export function EventForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  defaultTz,
}: EventFormProps) {
  const uid = useId();
  const roster = useTrip((s) => s.meta?.roster ?? []);
  const [v, setV] = useState<FormValues>(() => initialValues(initial, defaultTz));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones([v.startTz, v.endTz]), [v.startTz, v.endTz]);
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));
  const id = (k: string) => `${uid}-${k}`;
  const attrs = (k: keyof FormValues) => ({
    id: id(k),
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': errors[k] ? `${id(k)}-err` : undefined,
  });
  const text = (k: keyof FormValues) => ({
    ...attrs(k),
    value: v[k] as string,
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });

  /** Name input with place search. Picking fills name, address and coordinates; typing after a pick drops them. */
  const place = (k: 'location' | 'endLocation') => (
    <PlaceSearch
      id={id(`${k}Name`)}
      value={v[`${k}Name`]}
      onChange={(t) =>
        setV((prev) => ({
          ...prev,
          [`${k}Name`]: t,
          // Coordinates from a picked place no longer match once the name is edited.
          [`${k}Geo`]: prev[`${k}Picked`] ? null : prev[`${k}Geo`],
          [`${k}Picked`]: false,
        }))
      }
      onPick={(p) =>
        setV((prev) => ({
          ...prev,
          [`${k}Name`]: p.name ?? '',
          [`${k}Address`]: p.address ?? '',
          [`${k}Geo`]: geoOf(p),
          [`${k}Picked`]: geoOf(p) !== null,
        }))
      }
    />
  );

  const setAddress = (k: 'location' | 'endLocation', t: string) =>
    setV((prev) => ({
      ...prev,
      [`${k}Address`]: t,
      [`${k}Geo`]: prev[`${k}Picked`] ? null : prev[`${k}Geo`],
      [`${k}Picked`]: false,
    }));

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const r = buildFields(v, initial);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(r.fields);
    } catch {
      // The caller surfaces the failure (store lastError); keep the form open so nothing is lost.
    } finally {
      setBusy(false);
    }
  };

  const known = new Set(roster.map((r) => r.id));
  const everyone = v.participants.length === 0;

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Name" error={errors.name} id={id('name')}>
        <input type="text" required {...text('name')} />
      </Field>
      <div className={styles.pair}>
        <Field label="Type" id={id('type')}>
          <select
            {...attrs('type')}
            value={v.type}
            onChange={(e) => set('type', e.target.value as FormValues['type'])}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {isTransport(v.type) && (
          <Field label="Mode" id={id('mode')}>
            <select
              {...attrs('mode')}
              value={v.mode}
              onChange={(e) => set('mode', e.target.value as FormValues['mode'])}
            >
              <option value="">(unspecified)</option>
              {TRANSIT_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Status" id={id('status')}>
          <select
            {...attrs('status')}
            value={v.status}
            onChange={(e) => set('status', e.target.value as FormValues['status'])}
          >
            <option value="confirmed">confirmed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </Field>
      </div>

      {(['start', 'end'] as const).map((w) => {
        const dk = `${w}Date` as 'startDate' | 'endDate';
        const tk = `${w}Time` as 'startTime' | 'endTime';
        const zk = `${w}Tz` as 'startTz' | 'endTz';
        return (
          <fieldset key={w} className={styles.group}>
            <legend>{w === 'start' ? 'Start' : 'End'}</legend>
            <div className={styles.pair}>
              <Field label="Date" id={id(dk)} error={errors[dk]}>
                <input type="date" {...text(dk)} />
              </Field>
              <Field label="Time" id={id(tk)}>
                <input type="time" {...text(tk)} />
              </Field>
            </div>
            <Field label="Time zone" id={id(zk)}>
              <select {...attrs(zk)} value={v[zk]} onChange={(e) => set(zk, e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>
        );
      })}

      <Field label="Confirmation" id={id('confirmation')}>
        <input type="text" {...text('confirmation')} />
      </Field>
      <fieldset className={styles.group}>
        <legend>Location</legend>
        <Field label="Name" id={id('locationName')}>
          {place('location')}
        </Field>
        <Field label="Address" id={id('locationAddress')}>
          <input
            type="text"
            {...text('locationAddress')}
            onChange={(e) => setAddress('location', e.target.value)}
          />
        </Field>
      </fieldset>
      {isTransport(v.type) && (
        <fieldset className={styles.group}>
          <legend>Arrives at</legend>
          <Field label="Name" id={id('endLocationName')}>
            {place('endLocation')}
          </Field>
          <Field label="Address" id={id('endLocationAddress')}>
            <input
              type="text"
              {...text('endLocationAddress')}
              onChange={(e) => setAddress('endLocation', e.target.value)}
            />
          </Field>
        </fieldset>
      )}

      <fieldset className={styles.group}>
        <legend>Participants</legend>
        <div className={styles.chips}>
          <Chip selected={everyone} onClick={() => set('participants', [])}>
            Everyone
          </Chip>
          {roster.map((m) => (
            <Chip
              key={m.id}
              selected={v.participants.includes(m.id)}
              onClick={() =>
                set(
                  'participants',
                  v.participants.includes(m.id)
                    ? v.participants.filter((p) => p !== m.id)
                    : [...v.participants, m.id],
                )
              }
            >
              {m.name}
            </Chip>
          ))}
        </div>
        {v.participants.some((p) => !known.has(p)) && (
          <div className={styles.hint}>Former participants stay on the event.</div>
        )}
      </fieldset>

      <Field label="Notes" id={id('notes')}>
        <textarea rows={3} {...text('notes')} />
      </Field>

      <div className={styles.actions}>
        <Button primary type="submit" disabled={busy}>
          {busy ? 'Saving...' : submitLabel}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
