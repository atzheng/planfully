import { Monitor, Moon, Sun } from 'lucide-react';
import { IconButton } from '../ui/IconButton';
import { nextSetting, type ThemeSetting } from './theme';
import { useTheme } from './useTheme';

const LABEL: Record<ThemeSetting, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function Icon({ setting }: { setting: ThemeSetting }) {
  const Cmp = setting === 'light' ? Sun : setting === 'dark' ? Moon : Monitor;
  return <Cmp size={18} aria-hidden="true" />;
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
