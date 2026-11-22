// The one slim bar above the canvas (planfully-zbj.3). Everything else (filters, search, view,
// receipts, export, theme, zone, lanes, fit; weather and units are in the bar) sits behind an icon here; see CONTRACTS.md 7.

import { useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import {
  CalendarDays,
  ChevronsDownUp,
  CloudOff,
  ChevronDown,
  Cloud,
  Download,
  Globe,
  Layers,
  Map as MapIcon,
  Maximize2,
  Monitor,
  MoreHorizontal,
  Moon,
  Receipt,
  Search,
  Settings,
  Sun,
  Info,
  X,
} from 'lucide-react';
import { FilterButton, SearchField, useIsPhone } from '../filters/FilterControls';
import { filterSummary, useFilterState } from '../filters/filter';
import { useExport } from '../export/useExport';
import { AddReceiptAction, type ReceiptPicker } from '../event/UploadButtons';
import { booleanCodec, stringCodec, useQueryState } from '../lib/queryState';
import { nextSetting, type ThemeSetting } from '../theme/theme';
import { useTheme } from '../theme/useTheme';
import { useTimelineControls } from '../timeline/controls';
import { LANE_MODE_LABEL, laneModeCodec } from '../timeline/lanes';
import { LANE_MODES } from '../timeline/layout';
import { validZone } from '../timeline/model';
import { referenceMs, zoneSummary } from '../timeline/zones';
import { getTripQueue } from '../offline/queue';
import { useTrip, useTripStore } from '../trip/store';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Menu, type MenuItem } from '../ui/Menu';
import { useUnits } from '../weather/useUnits';
import { Sheet } from '../ui/Sheet';
import styles from './AppBar.module.css';

export type View = 'timeline' | 'map';

const THEME_LABEL: Record<ThemeSetting, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function ThemeIcon({ setting }: { setting: ThemeSetting }) {
  const Cmp = setting === 'light' ? Sun : setting === 'dark' ? Moon : Monitor;
  return <Cmp size={16} aria-hidden="true" />;
}

function TripInfo({ open, onClose }: { open: boolean; onClose: () => void }) {
  const meta = useTrip((s) => s.meta);
  const count = useTrip((s) => s.events.length);
  return (
    <Sheet open={open} onClose={onClose} label="Trip info">
      <div className={styles.info}>
        <h2 className={styles.infoTitle}>{meta?.name ?? 'Trip'}</h2>
        <dl className={styles.infoList}>
          <dt>Events</dt>
          <dd>{count}</dd>
          {meta?.address && (
            <>
              <dt>Forward emails to</dt>
              <dd>{meta.address}</dd>
            </>
          )}
          {meta && meta.roster.length > 0 && (
            <>
              <dt>Travelers</dt>
              <dd>{meta.roster.map((m) => m.name).join(', ')}</dd>
            </>
          )}
        </dl>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Sheet>
  );
}

export function AppBar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { tripId } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const size = phone ? 'sm' : 'md';
  const name = useTrip((s) => s.meta?.name);
  const roster = useTrip((s) => s.meta?.roster);
  const events = useTrip((s) => s.events);
  const status = useTrip((s) => s.status);
  const store = useTripStore();
  const waiting = useTrip((s) => (s.queueStalled ? s.pending : 0));
  const accessLost = useTrip((s) => s.queueAccessLost);
  const api = useFilterState();
  const exporter = useExport();
  const timeline = useTimelineControls();
  const { setting, setSetting } = useTheme();
  const [tzRaw] = useQueryState('tz', stringCodec, '');
  const [laneMode, setLaneMode] = useQueryState('lanes', laneModeCodec, 'none');
  const [wxOn, setWxOn] = useQueryState('wx', booleanCodec, false);
  const { system, setSystem } = useUnits();
  const [condense, setCondense] = useQueryState('condense', booleanCodec, false);
  const [searching, setSearching] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const receipt = useRef<ReceiptPicker>(null);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearching(false);
    // The field unmounts; hand focus back to the icon that opened it.
    setTimeout(() => searchBtn.current?.focus(), 0);
  };

  const summary = filterSummary(api.filter, roster ?? []);
  const onTimeline = view === 'timeline';
  const settingsTo = { pathname: `/t/${encodeURIComponent(tripId ?? '')}/settings`, hash };
  const zone = validZone(tzRaw, browserZone());

  const items: MenuItem[] = [
    ...(status === 'ready'
      ? [
          {
            label: 'Add receipt',
            icon: <Receipt size={16} aria-hidden="true" />,
            onSelect: () => receipt.current?.pick(),
          } satisfies MenuItem,
        ]
      : []),
    ...exporter.items.map((i): MenuItem => ({
      label: `Export ${i.label}`,
      icon: <Download size={16} aria-hidden="true" />,
      disabled: exporter.busy,
      onSelect: () => void exporter.choose(i),
    })),
    { separator: true },
    ...(onTimeline
      ? ([
          {
            label: `Time zone: ${zoneSummary(zone, referenceMs(events, Date.now()))}`,
            icon: <Globe size={16} aria-hidden="true" />,
            testId: 'tz-menu',
            onSelect: () => timeline?.setTzOpen(true),
          },
          ...LANE_MODES.map((m): MenuItem => ({
            label: `Lanes: ${LANE_MODE_LABEL[m]}`,
            icon: <Layers size={16} aria-hidden="true" />,
            checked: laneMode === m,
            keepOpen: true,
            testId: `lanes-${m}`,
            onSelect: () => setLaneMode(m),
          })),
          {
            label: 'Condense empty time',
            icon: <ChevronsDownUp size={16} aria-hidden="true" />,
            checked: condense,
            keepOpen: true,
            testId: 'condense-toggle',
            onSelect: () => setCondense(!condense),
          },
          {
            label: 'Fit trip',
            icon: <Maximize2 size={16} aria-hidden="true" />,
            disabled: !timeline?.canFit,
            onSelect: () => timeline?.fit(),
          },
          { separator: true },
        ] satisfies MenuItem[])
      : []),
    {
      label: `Theme: ${THEME_LABEL[setting]}`,
      icon: <ThemeIcon setting={setting} />,
      keepOpen: true,
      testId: 'theme-toggle',
      onSelect: () => setSetting(nextSetting(setting)),
    },
    {
      label: 'Settings',
      icon: <Settings size={16} aria-hidden="true" />,
      onSelect: () => navigate(settingsTo),
    },
  ];

  const tripItems: MenuItem[] = [
    {
      label: 'Trip info',
      icon: <Info size={16} aria-hidden="true" />,
      onSelect: () => setInfoOpen(true),
    },
    {
      label: 'Settings',
      icon: <Settings size={16} aria-hidden="true" />,
      onSelect: () => navigate(settingsTo),
    },
  ];

  const syncChip =
    waiting > 0 ? (
      <button
        type="button"
        className={`${styles.sync} ${accessLost ? styles.syncLost : ''}`}
        data-testid="sync-waiting"
        role="status"
        aria-label={
          accessLost
            ? `Link no longer has access: ${waiting} ${waiting === 1 ? 'change' : 'changes'} not sent. Select to discard`
            : `${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting to sync`
        }
        title={
          accessLost
            ? `${waiting} not sent: link no longer has access. Click to discard`
            : `${waiting} waiting to sync`
        }
        onClick={() => {
          if (accessLost && window.confirm('Discard the changes that could not be sent?')) {
            void getTripQueue(store).discard();
          }
        }}
      >
        <CloudOff size={14} aria-hidden="true" />
        {accessLost ? `Not sent: ${waiting}` : waiting}
      </button>
    ) : null;

  return (
    <>
      <header className={styles.bar} data-slot="app-bar">
        {searching ? (
          <>
            <SearchField api={api} onClose={closeSearch} />
            {syncChip}
          </>
        ) : (
          <>
            <div className={styles.lead}>
              <h1 className={styles.title} data-slot="trip-name">
                <Menu
                  label="Trip menu"
                  align="start"
                  items={tripItems}
                  trigger={(p) => (
                    <button type="button" className={styles.titleButton} {...p}>
                      <span className={styles.titleText}>{name ?? `Trip ${tripId}`}</span>
                      <ChevronDown size={14} aria-hidden="true" className={styles.titleChevron} />
                    </button>
                  )}
                />
              </h1>
              {summary && (
                <button
                  type="button"
                  className={styles.summary}
                  data-testid="filter-summary"
                  aria-label={`Clear filters: ${summary}`}
                  title="Clear filters"
                  onClick={api.clear}
                >
                  <span className={styles.summaryText}>{summary}</span>
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            {syncChip}
            {onTimeline && wxOn && (
              <IconButton
                size={size}
                className={`${styles.iconBtn} ${styles.unitsBtn}`}
                label={
                  system === 'imperial'
                    ? 'Units: imperial. Switch to metric'
                    : 'Units: metric. Switch to imperial'
                }
                data-testid="units-toggle"
                onClick={() => setSystem(system === 'imperial' ? 'metric' : 'imperial')}
              >
                {system === 'imperial' ? '°F' : '°C'}
              </IconButton>
            )}
            {onTimeline && (
              <IconButton
                size={size}
                className={`${styles.iconBtn} ${wxOn ? styles.iconBtnOn : ''}`}
                label="Weather"
                aria-pressed={wxOn}
                data-testid="wx-toggle"
                onClick={() => setWxOn(!wxOn)}
              >
                <Cloud size={18} aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              ref={searchBtn}
              size={size}
              className={styles.iconBtn}
              label="Search"
              onClick={() => setSearching(true)}
            >
              <Search size={18} aria-hidden="true" />
            </IconButton>
            <FilterButton api={api} phone={phone} size={size} className={styles.iconBtn} />
            <IconButton
              size={size}
              className={styles.iconBtn}
              label={onTimeline ? 'Show map' : 'Show timeline'}
              data-testid="view-toggle"
              onClick={() => setView(onTimeline ? 'map' : 'timeline')}
            >
              {onTimeline ? (
                <MapIcon size={18} aria-hidden="true" />
              ) : (
                <CalendarDays size={18} aria-hidden="true" />
              )}
            </IconButton>
            <Menu
              label="More"
              items={items}
              trigger={(p) => (
                <IconButton
                  size={size}
                  className={styles.iconBtn}
                  label="More"
                  data-testid="overflow"
                  {...p}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
                </IconButton>
              )}
            />
          </>
        )}
      </header>
      <div className={styles.toasts}>
        <AddReceiptAction ref={receipt} />
        {exporter.busy && (
          <span role="status" className={styles.toast}>
            Exporting...
          </span>
        )}
        {exporter.notice && (
          <p role="status" className={styles.toast}>
            {exporter.notice}{' '}
            <button type="button" className={styles.linkButton} onClick={exporter.dismiss}>
              Dismiss
            </button>
          </p>
        )}
        {exporter.error && (
          <p role="alert" className={`${styles.toast} ${styles.toastError}`}>
            {exporter.error}{' '}
            <button type="button" className={styles.linkButton} onClick={exporter.dismiss}>
              Dismiss
            </button>
          </p>
        )}
      </div>
      <TripInfo open={infoOpen} onClose={() => setInfoOpen(false)} />
    </>
  );
}
