import { Link, Outlet, Route, Routes, useParams } from 'react-router';
import { CreateTrip } from './create/CreateTrip';
import { Settings } from './settings/Settings';
import { TripShell } from './TripShell';
import { TripProvider } from './trip/store';

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

function TripLayout() {
  const { tripId = '' } = useParams();
  return (
    <TripProvider tripId={tripId}>
      <Outlet />
    </TripProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/new" element={<CreateTrip />} />
      <Route path="/t/:tripId" element={<TripLayout />}>
        <Route index element={<TripShell />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
