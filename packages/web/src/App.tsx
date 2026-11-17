import { Link, Route, Routes } from 'react-router';
import { CreateTrip } from './create/CreateTrip';
import { Settings } from './settings/Settings';
import { TripShell } from './TripShell';

function Landing() {
  return (
    <main style={{ padding: 'var(--space-5)' }}>
      <h1>Planfully</h1>
      <p>Trips from your inbox, kept private. Open a trip link to get started.</p>
      <Link to="/new">Create a trip</Link>
    </main>
  );
}

function NotFound() {
  return (
    <main style={{ padding: 'var(--space-5)' }}>
      <p>Not found.</p>
      <Link to="/">Home</Link>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/new" element={<CreateTrip />} />
      <Route path="/t/:tripId" element={<TripShell />} />
      <Route path="/t/:tripId/settings" element={<Settings />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
