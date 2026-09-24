import { Badge, Card, Loader, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api/client';
import { keys, useAction, useAdminUsers, useMe } from '../api/hooks';
import { PersonChip } from '../components/common';
import { fromNow } from '../lib/dates';

export function AdminPage() {
  const me = useMe();
  const users = useAdminUsers(!!me.data?.is_admin);
  const [q, setQ] = useState('');
  const update = useAction(
    (a: { id: number; body: object }) => api(`/api/admin/users/${a.id}`, { method: 'PATCH', body: a.body }),
    { invalidate: [keys.adminUsers] },
  );
  if (me.data && !me.data.is_admin) return <Navigate to="/" replace />;
  if (users.isLoading) return <Loader />;
  const filtered = (users.data ?? []).filter(
    (u) => !q || u.email.includes(q.toLowerCase()) || u.name.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Stack>
      <Title order={2}>Admin</Title>
      <Text c="dimmed" size="sm">
        People appear here automatically the first time they sign in, or when a leader adds them to
        a team. Admins can manage every team (see “Show all teams” on the Teams page).
      </Text>
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder="Search people"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        maw={360}
      />
      <Card p={0}>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Person</Table.Th>
                <Table.Th>Teams</Table.Th>
                <Table.Th>Last seen</Table.Th>
                <Table.Th>Admin</Table.Th>
                <Table.Th>Active</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((u) => (
                <Table.Tr key={u.id}>
                  <Table.Td>
                    <PersonChip user={u} />
                    <Text size="xs" c="dimmed" ml={28}>
                      {u.email}
                    </Text>
                  </Table.Td>
                  <Table.Td>{u.team_count}</Table.Td>
                  <Table.Td>
                    {u.last_seen_at ? (
                      <Text size="sm">{fromNow(u.last_seen_at)}</Text>
                    ) : (
                      <Badge variant="light" color="gray" size="sm">
                        never signed in
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={u.is_admin}
                      disabled={u.id === me.data?.id}
                      onChange={(e) => update.mutate({ id: u.id, body: { is_admin: e.currentTarget.checked } })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={u.active}
                      disabled={u.id === me.data?.id}
                      onChange={(e) => update.mutate({ id: u.id, body: { active: e.currentTarget.checked } })}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
