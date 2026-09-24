import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { keys, useAction, useMe } from '../../api/hooks';
import type { TeamDetail } from '../../api/types';
import { fmtDate } from '../../lib/dates';
import { PersonChip } from '../common';

export function MembersTab({ team }: { team: TeamDetail }) {
  const me = useMe();
  const navigate = useNavigate();
  const inv = [keys.team(team.id), keys.teams, keys.me];
  const update = useAction(
    (a: { userId: number; body: object }) =>
      api(`/api/teams/${team.id}/members/${a.userId}`, { method: 'PATCH', body: a.body }),
    { invalidate: inv },
  );
  const remove = useAction(
    (userId: number) => api(`/api/teams/${team.id}/members/${userId}`, { method: 'DELETE' }),
    {
      invalidate: inv,
      onSuccess: (_, userId) => {
        if (userId === me.data?.id) navigate('/');
      },
    },
  );

  const confirmRemove = (userId: number, name: string) =>
    modals.openConfirmModal({
      title: userId === me.data?.id ? 'Leave this team?' : `Remove ${name}?`,
      children: (
        <Text size="sm">
          Past shifts stay in the rota history. Future published shifts keep their assignment until
          a leader changes them.
        </Text>
      ),
      labels: { confirm: userId === me.data?.id ? 'Leave' : 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(userId),
    });

  const onCallCount = team.members.filter((m) => m.on_call).length;

  return (
    <Stack>
      {team.is_leader && <AddMember team={team} />}
      <Card p={0}>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Person</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>
                  <Tooltip label="Takes part in the on-call rotation">
                    <span>On call ({onCallCount})</span>
                  </Tooltip>
                </Table.Th>
                <Table.Th>Joined</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {team.members.map((m) => (
                <Table.Tr key={m.user.id}>
                  <Table.Td>
                    <PersonChip user={m.user} />
                    <Text size="xs" c="dimmed" ml={28}>
                      {m.user.email}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {team.is_leader ? (
                      <Select
                        size="xs"
                        w={120}
                        data={[
                          { value: 'leader', label: 'Leader' },
                          { value: 'member', label: 'Member' },
                        ]}
                        value={m.role}
                        allowDeselect={false}
                        onChange={(v) => update.mutate({ userId: m.user.id, body: { role: v } })}
                      />
                    ) : (
                      <Badge variant="light" color={m.role === 'leader' ? 'gator' : 'gray'}>
                        {m.role}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      checked={m.on_call}
                      disabled={!team.is_leader}
                      onChange={(e) =>
                        update.mutate({ userId: m.user.id, body: { on_call: e.currentTarget.checked } })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{fmtDate(m.joined_at)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {(team.is_leader || m.user.id === me.data?.id) && (
                      <Tooltip label={m.user.id === me.data?.id ? 'Leave team' : 'Remove from team'}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => confirmRemove(m.user.id, m.user.name)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
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

function AddMember({ team }: { team: TeamDetail }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>('member');
  const add = useAction(
    () =>
      api(`/api/teams/${team.id}/members`, {
        body: { email: email.trim(), display_name: name.trim(), role, on_call: true },
      }),
    {
      invalidate: [keys.team(team.id)],
      success: `Added ${email}. They'll see the team the next time they sign in.`,
      onSuccess: () => {
        setEmail('');
        setName('');
      },
    },
  );
  return (
    <Card>
      <Text fw={600} mb="xs">
        Add someone
      </Text>
      <Group align="flex-end">
        <TextInput
          label="Email (as used for sign-in)"
          placeholder="alex@example.com"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          style={{ flex: 2, minWidth: 220 }}
        />
        <TextInput
          label="Name"
          placeholder="Alex Doe"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <Select
          label="Role"
          data={[
            { value: 'member', label: 'Member' },
            { value: 'leader', label: 'Leader' },
          ]}
          value={role}
          onChange={(v) => setRole(v ?? 'member')}
          w={120}
          allowDeselect={false}
        />
        <Button
          leftSection={<IconUserPlus size={16} />}
          onClick={() => add.mutate(undefined)}
          loading={add.isPending}
          disabled={!email.includes('@')}
        >
          Add
        </Button>
      </Group>
    </Card>
  );
}
