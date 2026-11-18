// Dev-only (see App.tsx): every base component and token in one page. /dev/ui
import { useRef, useState } from 'react';
import { Download, Filter, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react';
import { EVENT_TYPES } from '@planfully/shared';
import { ThemeToggle } from '../theme/ThemeToggle';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EventIcon } from '../ui/EventIcon';
import { Field } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Input, Select, Textarea } from '../ui/Input';
import { Menu } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';

const GRAYS = Array.from({ length: 10 }, (_, i) => `--gray-${i + 1}`);
const ACCENTS = ['--accent', '--accent-hover', '--accent-pressed', '--accent-subtle'];
const SEMANTIC = [
  '--danger',
  '--danger-subtle',
  '--warning',
  '--warning-subtle',
  '--success',
  '--success-subtle',
];
const SURFACES = ['--bg', '--surface', '--surface-2', '--raised', '--border', '--border-strong'];

function Swatches({ names }: { names: string[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {names.map((n) => (
        <div key={n} style={{ width: 84, fontSize: 11 }}>
          <div
            style={{
              height: 28,
              background: `var(${n})`,
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
            }}
          />
          {n.slice(2)}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: '24px 0' }}>
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, margin: '0 0 8px' }}>{title}</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        {children}
      </div>
    </section>
  );
}

export default function Gallery() {
  const [lanes, setLanes] = useState<'none' | 'type' | 'participant'>('none');
  const [on, setOn] = useState(true);
  const [pop, setPop] = useState(false);
  const [sheet, setSheet] = useState(false);
  const popAnchor = useRef<HTMLButtonElement>(null);

  return (
    <main style={{ padding: 'var(--space-4)', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, margin: 0 }}>UI gallery</h1>
        <ThemeToggle />
      </div>

      <Section title="Colour tokens">
        <Swatches names={GRAYS} />
        <Swatches names={SURFACES} />
        <Swatches names={ACCENTS} />
        <Swatches names={SEMANTIC} />
      </Section>

      <Section title="Type scale (Inter, tabular times)">
        <div>
          {(['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const).map((s) => (
            <div key={s} style={{ fontSize: `var(--text-${s})` }}>
              text-{s} The quick brown fox, <time>09:05 to 12:40</time> 1234567890
            </div>
          ))}
          <div style={{ fontWeight: 500 }}>Medium 500 · Naïve café Łódź</div>
          <div style={{ fontWeight: 600 }}>Semibold 600</div>
        </div>
      </Section>

      <Section title="Event types">
        {EVENT_TYPES.map((t) => (
          <div
            key={t}
            data-type={t}
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              padding: '4px 8px',
              minWidth: 110,
              background: 'var(--type-bg)',
              color: 'var(--type-fg)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--type-bar)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <EventIcon type={t} /> {t}
          </div>
        ))}
        {(['flight', 'train', 'bus', 'ferry', 'car', 'other'] as const).map((m) => (
          <div
            key={m}
            data-type="transit"
            style={{
              display: 'flex',
              gap: 6,
              color: 'var(--type-fg)',
              background: 'var(--type-bg)',
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <EventIcon event={{ type: 'transit', mode: m }} /> {m}
          </div>
        ))}
      </Section>

      <Section title="Buttons">
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <Button variant="primary" size="sm">
          Small
        </Button>
        <Button size="sm">Small</Button>
        <Button variant="ghost" size="sm">
          <Plus size={14} /> With icon
        </Button>
        <IconButton label="Settings">
          <Settings size={18} />
        </IconButton>
        <IconButton label="Delete" variant="secondary" size="sm">
          <Trash2 size={16} />
        </IconButton>
        <Button fab aria-label="Add event" style={{ position: 'static' }}>
          <Plus size={22} />
        </Button>
      </Section>

      <Section title="Chips and badges">
        <Chip selected={on} onClick={() => setOn(!on)}>
          Dining
        </Chip>
        <Chip selected={!on} onClick={() => setOn(!on)}>
          Lodging
        </Chip>
        <Badge>3</Badge>
        <Badge tone="accent">12</Badge>
        <Badge tone="danger">!</Badge>
        <Badge tone="warning">review</Badge>
        <Badge tone="success">ok</Badge>
      </Section>

      <Section title="Fields">
        <div style={{ display: 'grid', gap: 12, width: 'min(100%, 360px)' }}>
          <Field label="Name" hint="Shown at the top of the trip">
            {(p) => <Input {...p} placeholder="Lisbon, May" />}
          </Field>
          <Field label="Email" error="Enter a valid address">
            {(p) => <Input {...p} defaultValue="nope" />}
          </Field>
          <Field label="Type">
            {(p) => (
              <Select {...p}>
                {EVENT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notes">{(p) => <Textarea {...p} />}</Field>
          <Input aria-label="Disabled" disabled defaultValue="Disabled" />
        </div>
      </Section>

      <Section title="Segmented control">
        <SegmentedControl
          label="Lanes"
          value={lanes}
          onChange={setLanes}
          options={[
            { value: 'none', label: 'None' },
            { value: 'type', label: 'Type' },
            { value: 'participant', label: 'People' },
          ]}
        />
        <SegmentedControl
          size="sm"
          label="Lanes small"
          value={lanes}
          onChange={setLanes}
          options={[
            { value: 'none', label: 'None' },
            { value: 'type', label: 'Type' },
            { value: 'participant', label: 'People' },
          ]}
        />
      </Section>

      <Section title="Menu, popover, sheet">
        <Menu
          label="More actions"
          items={[
            { label: 'Export PDF', icon: <Download size={16} />, onSelect: () => undefined },
            { label: 'Show weather', checked: true, onSelect: () => undefined, keepOpen: true },
            { separator: true },
            {
              label: 'Delete trip',
              icon: <Trash2 size={16} />,
              danger: true,
              onSelect: () => undefined,
            },
          ]}
          trigger={(p) => (
            <IconButton label="More" {...p} data-testid="gallery-menu">
              <MoreHorizontal size={18} />
            </IconButton>
          )}
        />
        <Button ref={popAnchor} onClick={() => setPop(!pop)} aria-expanded={pop}>
          <Filter size={16} /> Filters <Badge tone="accent">2</Badge>
        </Button>
        <Popover open={pop} onClose={() => setPop(false)} anchorRef={popAnchor} label="Filters">
          <div style={{ display: 'grid', gap: 8, width: 240 }}>
            <Field label="Search">{(p) => <Input {...p} />}</Field>
            <div style={{ display: 'flex', gap: 6 }}>
              <Chip selected>Dining</Chip>
              <Chip>Lodging</Chip>
            </div>
          </div>
        </Popover>
        <Button onClick={() => setSheet(true)}>Open sheet</Button>
        <Sheet open={sheet} onClose={() => setSheet(false)} label="Sample sheet">
          <h3 style={{ margin: '0 0 8px' }}>Sample sheet</h3>
          <p>Bottom sheet on phones, dialog on desktop.</p>
          <Button variant="primary" onClick={() => setSheet(false)}>
            Done
          </Button>
        </Sheet>
      </Section>
    </main>
  );
}
