import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes, useParams } from 'react-router';
import { CreateTrip } from './create/CreateTrip';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Settings } from './settings/Settings';
import { TripShell } from './TripShell';
import { TripProvider } from './trip/store';

// Dev-only component gallery; `import.meta.env.DEV` is false in production builds, so the route and chunk are dropped.
const Gallery = import.meta.env.DEV ? lazy(() => import('./dev/Gallery')) : null;

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
      {Gallery && (
        <Route
          path="/dev/ui"
          element={
            <Suspense fallback={null}>
              <Gallery />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
