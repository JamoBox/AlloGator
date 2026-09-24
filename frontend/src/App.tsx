import { Alert, Center, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from './api/hooks';
import { ChompLoader } from './components/brand';
import { Layout } from './components/Layout';

// Pages are split into their own chunks and prefetched while the browser is idle, so the first
// load is small and later navigation is instant.
const pages = {
  Dashboard: () => import('./pages/Dashboard'),
  AvailabilityPage: () => import('./pages/AvailabilityPage'),
  TeamsPage: () => import('./pages/TeamsPage'),
  TeamPage: () => import('./pages/TeamPage'),
  RotaPage: () => import('./pages/RotaPage'),
  ProfilePage: () => import('./pages/ProfilePage'),
  AdminPage: () => import('./pages/AdminPage'),
};
const Dashboard = lazy(() => pages.Dashboard().then((m) => ({ default: m.Dashboard })));
const AvailabilityPage = lazy(() =>
  pages.AvailabilityPage().then((m) => ({ default: m.AvailabilityPage })),
);
const TeamsPage = lazy(() => pages.TeamsPage().then((m) => ({ default: m.TeamsPage })));
const TeamPage = lazy(() => pages.TeamPage().then((m) => ({ default: m.TeamPage })));
const RotaPage = lazy(() => pages.RotaPage().then((m) => ({ default: m.RotaPage })));
const ProfilePage = lazy(() => pages.ProfilePage().then((m) => ({ default: m.ProfilePage })));
const AdminPage = lazy(() => pages.AdminPage().then((m) => ({ default: m.AdminPage })));

function usePrefetchPages() {
  useEffect(() => {
    const idle =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 800));
    idle(() => Object.values(pages).forEach((load) => void load()));
  }, []);
}

export function App() {
  const me = useMe();
  usePrefetchPages();

  if (me.isLoading) {
    return (
      <Center h="100vh">
        <ChompLoader label="Waking the gator…" />
      </Center>
    );
  }
  if (me.isError) {
    return (
      <Layout>
        <Center mt="xl">
          <Alert color="red" icon={<IconAlertTriangle />} title="Can't sign you in" maw={560}>
            <Stack gap="xs">
              <Text size="sm">{me.error.message}</Text>
              <Text size="sm" c="dimmed">
                AlloGator relies on your organisation's sign-in proxy. Try reloading the page or
                signing in again.
              </Text>
            </Stack>
          </Alert>
        </Center>
      </Layout>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<ChompLoader />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/availability" element={<AvailabilityPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamPage />} />
          <Route path="/teams/:teamId/rotas/:rotaId" element={<RotaPage />} />
          <Route path="/teams/:teamId/:tab" element={<TeamPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
