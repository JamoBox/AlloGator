import { Badge, Button, Card, Group, Loader, Stack, Switch, Table, Text, ThemeIcon } from '@mantine/core';
import { IconCalendarDown, IconPhoneCall } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMe, useTeamSchedule } from '../../api/hooks';
import type { ScheduleShift, TeamDetail } from '../../api/types';
import { dayjs, fmtDateTime, fromNow, inTz } from '../../lib/dates';
import { CalendarButton, downloadOrToast, PersonChip } from '../common';

export function ScheduleTab({ team }: { team: TeamDetail }) {
  const schedule = useTeamSchedule(team.id);
  const me = useMe();
  const [mineOnly, setMineOnly] = useState(false);

  if (schedule.isLoading) return <Loader />;
  const data = schedule.data;
  const now = dayjs();
  const shifts = (data?.shifts ?? []).filter(
    (s) => dayjs(s.end_at).isAfter(now) && (!mineOnly || s.user?.id === me.data?.id),
  );
  const byWeek = new Map<string, ScheduleShift[]>();
  for (const s of shifts) {
    const k = inTz(s.start_at, team.timezone).startOf('isoWeek').format('YYYY-MM-DD');
    byWeek.set(k, [...(byWeek.get(k) ?? []), s]);
  }

  return (
    <Stack>
      <Group justify="space-between" align="stretch">
        <Card style={{ flex: 1, minWidth: 260 }}>
          <Group gap="sm">
            <ThemeIcon size="lg" radius="xl" color={data?.on_call_now ? 'gator' : 'red'}>
              <IconPhoneCall size={18} />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                On call now
              </Text>
              {data?.on_call_now ? (
                <Group gap="xs">
                  <PersonChip user={data.on_call_now.user} size="md" />
                  <Text size="sm" c="dimmed">
                    until {fmtDateTime(data.on_call_now.end_at, team.timezone)} (
                    {fromNow(data.on_call_now.end_at)})
                  </Text>
                </Group>
              ) : (
                <Text fw={600} c="red">
                  Nobody — no published rota covers right now
                </Text>
              )}
            </div>
          </Group>
        </Card>
        <Group>
          <CalendarButton query={`?team_id=${team.id}`} feedUrl={me.data?.calendar_feed_url} label="My shifts" />
          <Button
            variant="default"
            leftSection={<IconCalendarDown size={16} />}
            onClick={() =>
              downloadOrToast(`/api/teams/${team.id}/export?format=ics`, `${team.name}-on-call.ics`)
            }
          >
            Whole team (.ics)
          </Button>
        </Group>
      </Group>

      <Card>
        <Group justify="space-between" mb="sm">
          <Text fw={700} size="lg">
            Upcoming
          </Text>
          <Switch label="Only my shifts" checked={mineOnly} onChange={(e) => setMineOnly(e.currentTarget.checked)} />
        </Group>
        {shifts.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing published yet. Leaders publish rotas from the Rotas tab.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={130}>Week of</Table.Th>
                  <Table.Th>On call</Table.Th>
                  <Table.Th>From</Table.Th>
                  <Table.Th>To</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {[...byWeek.entries()].map(([week, items]) =>
                  items.map((s, i) => {
                    const mine = s.user?.id === me.data?.id;
                    return (
                      <Table.Tr key={s.id} bg={mine ? 'var(--mantine-color-gator-light)' : undefined}>
                        {i === 0 && (
                          <Table.Td rowSpan={items.length} style={{ verticalAlign: 'top' }}>
                            <Text size="sm" fw={600}>
                              {dayjs(week).format('D MMM')}
                            </Text>
                          </Table.Td>
                        )}
                        <Table.Td>
                          <Group gap="xs">
                            <PersonChip user={s.user} />
                            {mine && (
                              <Badge size="xs" variant="light">
                                you
                              </Badge>
                            )}
                            {s.note.startsWith('Swap') && (
                              <Badge size="xs" variant="light" color="grape">
                                swapped
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{fmtDateTime(s.start_at, team.timezone)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{fmtDateTime(s.end_at, team.timezone)}</Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  }),
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Text size="xs" c="dimmed" mt="sm">
          See past and draft rotas on the <Link to={`/teams/${team.id}/rotas`}>Rotas</Link> tab.
        </Text>
      </Card>
    </Stack>
  );
}
