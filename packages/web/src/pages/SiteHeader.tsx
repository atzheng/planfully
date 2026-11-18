import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ThemeToggle } from '../theme/ThemeToggle';
import styles from './pages.module.css';

/** Header for pages outside the trip shell: brand on the left, optional actions, theme toggle. */
export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <Link to="/" className={styles.brand} aria-label="Planfully home">
        <img src="/icon.svg" alt="" width={20} height={20} className={styles.logo} />
        Planfully
      </Link>
      <div className={styles.headerActions}>
        {children}
        <ThemeToggle />
      </div>
    </header>
  );
}
