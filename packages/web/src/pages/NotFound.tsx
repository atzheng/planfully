import { Link } from 'react-router';
import { buttonClass } from '../ui/Button';
import { SiteHeader } from './SiteHeader';
import styles from './pages.module.css';

export function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className={`${styles.main} ${styles.center}`}>
        <p className={styles.code}>404</p>
        <h1 className={styles.title}>We could not find that page</h1>
        <p className={styles.lead}>The link may be mistyped or out of date.</p>
        <Link to="/" className={buttonClass({ variant: 'primary' })}>
          Back to home
        </Link>
      </main>
    </>
  );
}
