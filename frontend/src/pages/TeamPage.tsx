import { Badge, Group, Loader, Stack, Tabs, Text, Title } from '@mantine/core';
import {
  IconArrowsExchange,
  IconCalendarEvent,
  IconDatabaseExport,
  IconListDetails,
  IconSettings,
  IconUsers,
} from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSwaps, useTeam } from '../api/hooks';
import { DataTab } from '../components/team/DataTab';
import { MembersTab } from '../components/team/MembersTab';
import { RotasTab } from '../components/team/RotasTab';
import { ScheduleTab } from '../components/team/ScheduleTab';
import { SettingsTab } from '../components/team/SettingsTab';
import { SwapsTab } from '../components/team/SwapsTab';

const TABS = ['schedule', 'rotas', 'swaps', 'members', 'data', 'settings'] as const;

export function TeamPage() {
  const params = useParams();
  const id = Number(params.teamId);
  const tab = TABS.includes(params.tab as (typeof TABS)[number]) ? params.tab! : 'schedule';
  const navigate = useNavigate();
  const team = useTeam(id);
  const swaps = useSwaps(id);

  if (team.isLoading) return <Loader />;
  if (team.isError || !team.data) return <Text c="red">{team.error?.message ?? 'Team not found'}</Text>;
  const t = team.data;
  const openSwaps = swaps.data?.filter((s) => s.status === 'open').length ?? 0;

  return (
    <Stack gap="md">
      <div>
        <Group gap="sm">
          <Title order={2}>{t.name}</Title>
          {t.is_leader && <Badge variant="light">Leader</Badge>}
        </Group>
        {t.description && <Text c="dimmed">{t.description}</Text>}
        <Text size="xs" c="dimmed">
          Times shown in {t.timezone}
        </Text>
      </div>
      <Tabs value={tab} onChange={(v) => navigate(`/teams/${id}/${v}`)} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="schedule" leftSection={<IconCalendarEvent size={16} />}>
            Schedule
          </Tabs.Tab>
          <Tabs.Tab value="rotas" leftSection={<IconListDetails size={16} />}>
            Rotas
          </Tabs.Tab>
          <Tabs.Tab
            value="swaps"
            leftSection={<IconArrowsExchange size={16} />}
            rightSection={
              openSwaps ? (
                <Badge size="xs" circle color="grape">
                  {openSwaps}
                </Badge>
              ) : null
            }
          >
            Swaps
          </Tabs.Tab>
          <Tabs.Tab value="members" leftSection={<IconUsers size={16} />}>
            Members
          </Tabs.Tab>
          <Tabs.Tab value="data" leftSection={<IconDatabaseExport size={16} />}>
            Import / export
          </Tabs.Tab>
          {t.is_leader && (
            <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
              Settings
            </Tabs.Tab>
          )}
        </Tabs.List>
        <Tabs.Panel value="schedule" pt="md">
          <ScheduleTab team={t} />
        </Tabs.Panel>
        <Tabs.Panel value="rotas" pt="md">
          <RotasTab team={t} />
        </Tabs.Panel>
        <Tabs.Panel value="swaps" pt="md">
          <SwapsTab team={t} />
        </Tabs.Panel>
        <Tabs.Panel value="members" pt="md">
          <MembersTab team={t} />
        </Tabs.Panel>
        <Tabs.Panel value="data" pt="md">
          <DataTab team={t} />
        </Tabs.Panel>
        {t.is_leader && (
          <Tabs.Panel value="settings" pt="md">
            <SettingsTab team={t} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
}
