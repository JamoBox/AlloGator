import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { keys, useAction, useMe, useTeams } from '../api/hooks';
import type { TeamDetail } from '../api/types';

export function timezoneOptions(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  }
}

export function TeamsPage() {
  const me = useMe();
  const [all, setAll] = useState(false);
  const teams = useTeams(all);
  const [opened, modal] = useDisclosure(false);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Teams</Title>
        <Group>
          {me.data?.is_admin && (
            <Switch label="Show all teams" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
          )}
          {me.data?.can_create_teams && (
            <Button leftSection={<IconPlus size={16} />} onClick={modal.open}>
              New team
            </Button>
          )}
        </Group>
      </Group>
      {teams.data?.length === 0 && (
        <Text c="dimmed">You're not a member of any team yet.</Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {teams.data?.map((t) => (
          <Card key={t.id} component={Link} to={`/teams/${t.id}`} padding="lg">
            <Group justify="space-between" mb={4}>
              <Text fw={700} size="lg">
                {t.name}
              </Text>
              {t.my_role && (
                <Badge variant="light" color={t.my_role === 'leader' ? 'gator' : 'gray'}>
                  {t.my_role}
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed" lineClamp={2} mih={40}>
              {t.description || 'No description'}
            </Text>
            <Group gap="xs" mt="sm">
              <IconUsers size={14} />
              <Text size="xs" c="dimmed">
                {t.member_count} members · {t.timezone} · {t.default_period_days}-day periods
              </Text>
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      <Modal opened={opened} onClose={modal.close} title="Create a team">
        <CreateTeamForm onDone={modal.close} />
      </Modal>
    </Stack>
  );
}

function CreateTeamForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState<string | null>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const create = useAction(
    () => api<TeamDetail>('/api/teams', { body: { name, description, timezone } }),
    {
      invalidate: [keys.teams, keys.me],
      success: 'Team created. Add your team members next.',
      onSuccess: (team) => {
        onDone();
        navigate(`/teams/${team.id}/members`);
      },
    },
  );
  return (
    <Stack>
      <TextInput label="Team name" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
      <Textarea label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
      <Select
        label="Timezone"
        description="Handover times and calendar days are in this timezone"
        data={timezoneOptions()}
        value={timezone}
        onChange={setTimezone}
        searchable
      />
      <Text size="xs" c="dimmed">
        You'll be the team's leader. Rota defaults (1-week periods, Monday 09:00 handover) can be
        changed in the team settings.
      </Text>
      <Group justify="flex-end">
        <Button onClick={() => create.mutate(undefined)} loading={create.isPending} disabled={!name.trim()}>
          Create team
        </Button>
      </Group>
    </Stack>
  );
}
