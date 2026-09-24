import {
  Anchor,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconArrowsExchange,
  IconCalendarOff,
  IconClipboardList,
  IconPhoneCall,
} from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useMe, useMyShifts, usePrefetch, useTodo } from '../api/hooks';
import type { ScheduleShift } from '../api/types';
import { CrocEmpty } from '../components/brand';
import { CalendarButton, RotaStatusBadge, SectionTitle } from '../components/common';
import { dayjs, fmtDateLong, fmtDateRange, fmtDateTime, fromNow } from '../lib/dates';

export function Dashboard() {
  const me = useMe();
  const shifts = useMyShifts();
  const todo = useTodo();
  const prefetch = usePrefetch();

  if (!me.data) return <Loader />;
  const first = me.data.name.split(' ')[0];

  if (me.data.memberships.length === 0) {
    return (
      <Stack>
        <Title order={2}>Welcome, {first}</Title>
        <Card p="xl">
          <CrocEmpty
            title="You're not in an on-call team yet"
            description="Ask a team leader to add you by email, or create a team if you're setting up a new rota."
          >
            {me.data.can_create_teams && (
              <Button component={Link} to="/teams" mt="md">
                Create a team
              </Button>
            )}
          </CrocEmpty>
        </Card>
      </Stack>
    );
  }

  const now = dayjs();
  const current = shifts.data?.find((s) => dayjs(s.start_at).isBefore(now) && dayjs(s.end_at).isAfter(now));
  const next = shifts.data?.find((s) => dayjs(s.start_at).isAfter(now));
  const t = todo.data;
  const attention =
    (t?.dates_needed.length ?? 0) +
    (t?.swap_requests_to_help.length ?? 0) +
    (t?.my_swap_requests.length ?? 0) +
    (t?.rotas_in_progress.length ?? 0);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Hi {first} 👋</Title>
          <Text c="dimmed">Here's your on-call at a glance.</Text>
        </div>
        <CalendarButton feedUrl={me.data.calendar_feed_url} label="My calendar" />
      </Group>

      <Grid>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <NextShiftCard current={current} next={next} loading={shifts.isLoading} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card h="100%">
            <SectionTitle>Needs your attention</SectionTitle>
            {todo.isLoading && <Loader size="sm" />}
            {t && attention === 0 && (
              <CrocEmpty sleepy size={64} title="All caught up" description="Nothing needs you right now — the gator's having a nap." />
            )}
            <Stack gap="xs">
              {t?.dates_needed.map((r) => (
                <TodoRow
                  key={`d${r.id}`}
                  icon={<IconCalendarOff size={16} />}
                  color="blue"
                  to={`/availability?rota=${r.id}`}
                  title={`Submit your dates: ${r.team_name}`}
                  detail={`${fmtDateRange(r.start_date, r.end_date)}${
                    r.availability_deadline ? ` · due ${fmtDateLong(r.availability_deadline)}` : ''
                  }`}
                  action="Add dates"
                />
              ))}
              {t?.swap_requests_to_help.map((s) => (
                <TodoRow
                  key={`s${s.id}`}
                  icon={<IconArrowsExchange size={16} />}
                  color="grape"
                  to={`/teams/${s.team_id}/swaps?request=${s.id}`}
                  title={`${s.requester.name} needs cover`}
                  detail={`${s.team_name} · ${fmtDateTime(s.start_at)} → ${fmtDateTime(s.end_at)}`}
                  action="Help out"
                />
              ))}
              {t?.my_swap_requests.map((s) => {
                const pending = s.offers.filter((o) => o.status === 'pending').length;
                return (
                  <TodoRow
                    key={`m${s.id}`}
                    icon={<IconArrowsExchange size={16} />}
                    color={pending ? 'orange' : 'gray'}
                    to={`/teams/${s.team_id}/swaps?request=${s.id}`}
                    title={pending ? `${pending} offer(s) on your swap request` : 'Your swap request is open'}
                    detail={`${fmtDateTime(s.start_at)} → ${fmtDateTime(s.end_at)}`}
                    action={pending ? 'Review' : 'View'}
                  />
                );
              })}
              {t?.rotas_in_progress.map((r) => (
                <TodoRow
                  key={`r${r.id}`}
                  onHover={() => prefetch.rota(r.id, true)}
                  icon={<IconClipboardList size={16} />}
                  color="orange"
                  to={`/teams/${r.team_id}/rotas/${r.id}`}
                  title={`Rota to finish: ${r.team_name}`}
                  detail={`${fmtDateRange(r.start_date, r.end_date)} · ${r.submitted_count}/${r.eligible_count} dates in`}
                  badge={<RotaStatusBadge status={r.status} />}
                  action="Open"
                />
              ))}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <Card>
        <SectionTitle>My upcoming on-call</SectionTitle>
        {shifts.data?.length === 0 ? (
          <Text c="dimmed" size="sm">
            No upcoming shifts in any published rota.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Team</Table.Th>
                  <Table.Th>From</Table.Th>
                  <Table.Th>To</Table.Th>
                  <Table.Th>Length</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shifts.data?.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/teams/${s.team_id}/rotas/${s.rota_id}`}>
                        {s.team_name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{fmtDateTime(s.start_at)}</Table.Td>
                    <Table.Td>{fmtDateTime(s.end_at)}</Table.Td>
                    <Table.Td>{durationLabel(s)}</Table.Td>
                    <Table.Td>
                      {s.note && (
                        <Badge variant="light" color="grape" size="sm">
                          {s.note.startsWith('Swap') ? 'Swapped' : 'Note'}
                        </Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}

function durationLabel(s: ScheduleShift) {
  const hours = dayjs(s.end_at).diff(dayjs(s.start_at), 'hour', true);
  if (hours >= 23) {
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  return `${Math.round(hours)} h`;
}

function NextShiftCard({
  current,
  next,
  loading,
}: {
  current?: ScheduleShift;
  next?: ScheduleShift;
  loading: boolean;
}) {
  const s = current ?? next;
  return (
    <Card
      h="100%"
      bg={current ? 'var(--mantine-color-gator-light)' : undefined}
      style={{ borderColor: current ? 'var(--mantine-color-gator-6)' : undefined }}
    >
      <Group gap="xs" mb="xs">
        <ThemeIcon radius="xl" variant={current ? 'filled' : 'light'}>
          <IconPhoneCall size={16} />
        </ThemeIcon>
        <Text fw={700} size="lg">
          {current ? "You're on call now" : 'Your next on-call'}
        </Text>
      </Group>
      {loading && <Loader size="sm" />}
      {!loading && !s && (
        <Text c="dimmed">Nothing scheduled. Enjoy the quiet!</Text>
      )}
      {s && (
        <Stack gap={4}>
          <Text size="xl" fw={700}>
            {s.team_name}
          </Text>
          <Text>
            {fmtDateTime(s.start_at)} → {fmtDateTime(s.end_at)}
          </Text>
          <Text size="sm" c="dimmed">
            {current ? `Ends ${fromNow(s.end_at)}` : `Starts ${fromNow(s.start_at)}`}
          </Text>
          <Group mt="sm">
            <Button
              component={Link}
              to={`/teams/${s.team_id}/rotas/${s.rota_id}`}
              variant="light"
              size="xs"
            >
              View rota
            </Button>
            <Button component={Link} to={`/teams/${s.team_id}/swaps`} variant="subtle" size="xs">
              Need a swap?
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function TodoRow({
  icon,
  color,
  to,
  title,
  detail,
  action,
  badge,
  onHover,
}: {
  icon: React.ReactNode;
  color: string;
  to: string;
  title: string;
  detail: string;
  action: string;
  badge?: React.ReactNode;
  onHover?: () => void;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" onMouseEnter={onHover}>
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon variant="light" color={color} radius="xl">
          {icon}
        </ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} truncate>
              {title}
            </Text>
            {badge}
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {detail}
          </Text>
        </div>
      </Group>
      <Button component={Link} to={to} size="xs" variant="light" color={color} style={{ flexShrink: 0 }}>
        {action}
      </Button>
    </Group>
  );
}
