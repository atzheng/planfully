import { IconButton } from '../ui/IconButton';
import { nextSetting, type ThemeSetting } from './theme';
import { useTheme } from './useTheme';

const LABEL: Record<ThemeSetting, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function Icon({ setting }: { setting: ThemeSetting }) {
  const p = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (setting === 'light')
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (setting === 'dark')
    return (
      <svg {...p}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
      </svg>
    );
  return (
    <svg {...p}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** Icon-only control cycling System, Light, Dark. Self-contained: drop it anywhere. */
export function ThemeToggle() {
  const { setting, setSetting } = useTheme();
  return (
    <IconButton
      data-testid="theme-toggle"
      data-theme-setting={setting}
      label={`Theme: ${LABEL[setting]}. Switch to ${LABEL[nextSetting(setting)]}`}
      onClick={() => setSetting(nextSetting(setting))}
    >
      <Icon setting={setting} />
    </IconButton>
  );
}
