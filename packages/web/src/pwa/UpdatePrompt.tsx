import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '../ui/Button';
import styles from './UpdatePrompt.module.css';

/** Registers the service worker and offers a reload when a new version is waiting. */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className={styles.prompt} role="status">
      <span className={styles.text}>New version available</span>
      <Button variant="ghost" size="sm" onClick={() => setNeedRefresh(false)}>
        Later
      </Button>
      <Button variant="primary" size="sm" onClick={() => void updateServiceWorker(true)}>
        Reload
      </Button>
    </div>
  );
}
