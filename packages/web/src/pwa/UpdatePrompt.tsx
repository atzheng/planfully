import { useRegisterSW } from 'virtual:pwa-register/react';
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
      <span>New version available</span>
      <button
        type="button"
        className={styles.reload}
        onClick={() => void updateServiceWorker(true)}
      >
        Reload
      </button>
      <button type="button" className={styles.dismiss} onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
