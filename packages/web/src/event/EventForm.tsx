import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Event } from '@planfully/shared';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Field } from '../ui/Field';
import { Input, Select, Textarea } from '../ui/Input';
import { Popover } from '../ui/Popover';
import { ZoneSearchList } from '../timeline/ZoneSearchList';
import {
  allZones,
  canonicalZone,
  cityName,
  offsetLabel,
  sameZone,
  searchZones,
  tripZones,
} from '../timeline/zones';
import { PlaceSearch } from './PlaceSearch';
import {
  buildFields,
  EVENT_TYPES,
  TRANSIT_MODES,
  geoOf,
  initialValues,
  isTransport,
  type EventFields,
  type FormErrors,
  type FormValues,
} from './formModel';
import { modeLabel, statusLabel, typeLabel, zoneCity } from './labels';
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The zone as a quiet suffix; pressing it opens a selector. */
function ZoneButton({
  label,
  value,
  tripZoneList,
  onChange,
}: {
  label: string;
  value: string;
  /** Zones used by the trip, offered before any search. */
  tripZoneList: readonly string[];
  onChange: (tz: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLButtonElement>(null);
  const atMs = useMemo(() => Date.now(), []);
  const items = useMemo(() => {
    const zs = query.trim() === '' ? tripZoneList : searchZones(query, allZones());
    return zs.map((z) => {
      const c = canonicalZone(z) ?? z;
      return {
        value: c,
        name: cityName(c),
        meta: `${c.split('/')[0]} · ${offsetLabel(c, atMs)}`,
        active: sameZone(c, value),
      };
    });
  }, [query, tripZoneList, value, atMs]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.zone}
        aria-label={`${label}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value}
        onClick={() => setOpen((o) => !o)}
      >
        {zoneCity(value)}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        label={label}
        align="end"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          // Close and return focus to the trigger; keep the key from the Sheet's focus trap.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }}
      >
        <div className={styles.zonePop}>
          <ZoneSearchList
            label={label}
            query={query}
            onQueryChange={setQuery}
            items={items}
            onPick={(z) => {
              onChange(z);
              setOpen(false);
            }}
            emptyText={query.trim() !== '' ? 'No matching zone.' : undefined}
          />
        </div>
      </Popover>
    </>
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
  const trip = useTrip((s) => s.events);
  const tripZoneList = useMemo(
    () => tripZones(trip, [v.startTz, v.endTz]),
    [trip, v.startTz, v.endTz],
  );
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));
  const id = (k: string) => `${uid}-${k}`;
  /** Name input with place search. Picking fills name, address and coordinates; typing after a pick drops them. */
  const place = (k: 'location' | 'endLocation', fieldId: string) => (
    <PlaceSearch
      id={fieldId}
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

  const timeRow = (w: 'start' | 'end') => {
    const dk = `${w}Date` as 'startDate' | 'endDate';
    const tk = `${w}Time` as 'startTime' | 'endTime';
    const zk = `${w}Tz` as 'startTz' | 'endTz';
    const name = w === 'start' ? 'Start' : 'End';
    const lid = id(`${w}Label`);
    return (
      <div className={styles.when} role="group" aria-labelledby={lid}>
        <div className={styles.whenHead}>
          <span id={lid} className={styles.whenLabel}>
            {w === 'start' ? 'Starts' : 'Ends'}
          </span>
          <ZoneButton
            label={`${name} time zone`}
            value={v[zk]}
            tripZoneList={tripZoneList}
            onChange={(tz) => set(zk, tz)}
          />
        </div>
        <Input
          type="date"
          aria-label={`${name} date`}
          invalid={Boolean(errors[dk])}
          aria-describedby={errors[dk] ? `${id(dk)}-err` : undefined}
          value={v[dk]}
          onChange={(e) => set(dk, e.target.value)}
        />
        <Input
          type="time"
          aria-label={`${name} time`}
          value={v[tk]}
          onChange={(e) => set(tk, e.target.value)}
        />
        {errors[dk] && (
          <p id={`${id(dk)}-err`} role="alert" className={styles.rowError}>
            {errors[dk]}
          </p>
        )}
      </div>
    );
  };

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <Section title="What">
        <Field label="Name" error={errors.name} required>
          {(p) => (
            <Input
              {...p}
              type="text"
              placeholder="Dinner at Belcanto"
              value={v.name}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <div className={styles.cols}>
          <Field label="Type">
            {(p) => (
              <Select
                {...p}
                value={v.type}
                onChange={(e) => set('type', e.target.value as FormValues['type'])}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {isTransport(v.type) && (
            <Field label="Transit mode">
              {(p) => (
                <Select
                  {...p}
                  value={v.mode}
                  onChange={(e) => set('mode', e.target.value as FormValues['mode'])}
                >
                  <option value="">Unspecified</option>
                  {TRANSIT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {modeLabel(m)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Status">
            {(p) => (
              <Select
                {...p}
                value={v.status}
                onChange={(e) => set('status', e.target.value as FormValues['status'])}
              >
                {(['confirmed', 'cancelled'] as const).map((st) => (
                  <option key={st} value={st}>
                    {statusLabel(st)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <Section title="When">
        {timeRow('start')}
        {timeRow('end')}
      </Section>

      <Section title="Where">
        <div className={styles.cols}>
          <Field label={isTransport(v.type) ? 'From' : 'Location'}>
            {(p) => place('location', p.id)}
          </Field>
          <Field label="Address">
            {(p) => (
              <Input
                {...p}
                type="text"
                value={v.locationAddress}
                onChange={(e) => setAddress('location', e.target.value)}
              />
            )}
          </Field>
        </div>
        {isTransport(v.type) && (
          <div className={styles.cols}>
            <Field label="Arrives at">{(p) => place('endLocation', p.id)}</Field>
            <Field label="Arrival address">
              {(p) => (
                <Input
                  {...p}
                  type="text"
                  value={v.endLocationAddress}
                  onChange={(e) => setAddress('endLocation', e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
      </Section>

      <Section title="Who">
        <div className={styles.chips} role="group" aria-label="Participants">
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
          <p className={styles.hint}>Former participants stay on the event.</p>
        )}
      </Section>

      <Section title="Details">
        <Field label="Confirmation">
          {(p) => (
            <Input
              {...p}
              type="text"
              value={v.confirmation}
              onChange={(e) => set('confirmation', e.target.value)}
            />
          )}
        </Field>
        <Field label="Notes">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={v.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>
      </Section>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
