import styles from './ui.module.css';

/**
 * Round participant initials. `tone` 1-8 picks a palette colour (see `--person-N-*` in theme.css);
 * `'neutral'` is the quiet grey; omitted keeps the accent look used in the event sheet. Decorative:
 * always aria-hidden, the name is given as text next to it.
 */
export function Avatar({
  label,
  tone,
  size = 'md',
}: {
  label: string;
  tone?: number | 'neutral';
  size?: 'sm' | 'md';
}) {
  const cls = [
    styles.avatar,
    size === 'sm' ? styles.avatarSm : '',
    tone === 'neutral' ? styles.avatarNeutral : '',
  ]
    .join(' ')
    .trim();
  return (
    <span
      className={cls}
      data-tone={typeof tone === 'number' ? tone : undefined}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
