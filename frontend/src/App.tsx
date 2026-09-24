import { Alert, Center, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from './api/hooks';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/AdminPage';
import { AvailabilityPage } from './pages/AvailabilityPage';
import { Dashboard } from './pages/Dashboard';
import { ProfilePage } from './pages/ProfilePage';
import { RotaPage } from './pages/RotaPage';
import { TeamPage } from './pages/TeamPage';
import { TeamsPage } from './pages/TeamsPage';

export function App() {
  const me = useMe();

  if (me.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
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
    </Layout>
  );
}
