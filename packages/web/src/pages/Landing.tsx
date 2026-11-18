import { Link } from 'react-router';
import { RecentTrips } from '../offline/RecentTrips';
import { buttonClass } from '../ui/Button';
import { SiteHeader } from './SiteHeader';
import styles from './pages.module.css';

const STEPS = [
  {
    title: 'Forward your bookings',
    body: 'Flights, hotels, rentals and tickets: send the confirmation emails to your trip address.',
  },
  {
    title: 'We read them for you',
    body: 'Each email is parsed into events with times, places and confirmation numbers.',
  },
  {
    title: 'One shared itinerary',
    body: 'Open the private link on any device to see a timeline and a map.',
  },
];

export function Landing() {
  return (
    <>
      <SiteHeader />
      <main className={styles.main}>
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>Your trip, assembled from your inbox.</h1>
          <p className={styles.lead}>
            Email your bookings to Planfully and get a clean itinerary. Trip details are encrypted
            before they are stored, and only people with your trip link can read them.
          </p>
          <Link to="/new" className={buttonClass({ variant: 'primary', className: styles.cta })}>
            Create a trip
          </Link>
        </section>
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <span className={styles.stepNum} aria-hidden="true">
                {i + 1}
              </span>
              <h2 className={styles.stepTitle}>{s.title}</h2>
              <p className={styles.stepBody}>{s.body}</p>
            </li>
          ))}
        </ol>
        <p className={styles.fine}>
          Emails are read by an AI service to extract events, and addresses are sent to a map
          service to place them. Stored trip data stays encrypted; traveller names and allowed
          senders are kept in plain text so email can be routed.
        </p>
        <RecentTrips />
      </main>
    </>
  );
}
