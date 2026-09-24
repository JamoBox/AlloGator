import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconInfoCircle, IconTrash } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { keys, useAction, useMyShifts, useMyUnavailability, useTodo } from '../api/hooks';
import type { AvailabilityKind, Rota, Unavailability } from '../api/types';
import { AvailabilityCalendar } from '../components/AvailabilityCalendar';
import { dayjs, eachDay, fmtDateLong, fmtDateRange, fromNow, groupRuns, inTz, ISO } from '../lib/dates';

export function AvailabilityPage() {
  const [params] = useSearchParams();
  const focusRota = Number(params.get('rota')) || null;
  const entries = useMyUnavailability();
  const todo = useTodo();
  const shifts = useMyShifts();

  const save = useAction(
    (a: { dates: string[]; kind: AvailabilityKind | null; note: string }) =>
      api<Unavailability[]>('/api/me/unavailability', { body: a }),
    {
      invalidate: [keys.myUnavailability, ['rotas']],
      success: (_, a) =>
        a.kind === null
          ? `Cleared ${a.dates.length} day(s)`
          : `Marked ${a.dates.length} day(s) as ${a.kind === 'unavailable' ? "can't cover" : 'partly available'}`,
    },
  );

  const openRotas: Rota[] = todo.data?.collecting ?? [];
  const focus = openRotas.find((r) => r.id === focusRota) ?? openRotas.find((r) => !r.my_submitted);
  const highlights = openRotas.map((r) => ({
    start: r.start_date,
    end: r.end_date,
    label: `${r.team_name} (${fmtDateRange(r.start_date, r.end_date)})`,
  }));
  const onCallDates = useMemo(() => {
    const s = new Set<string>();
    for (const sh of shifts.data ?? []) {
      const start = inTz(sh.start_at).format(ISO);
      const end = inTz(sh.end_at).subtract(1, 'minute').format(ISO);
      for (const d of eachDay(start, end)) s.add(d);
    }
    return s;
  }, [shifts.data]);

  if (entries.isLoading) return <Loader />;

  const upcoming = (entries.data ?? []).filter((e) => e.date >= dayjs().format(ISO));

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>My availability</Title>
        <Text c="dimmed">
          Mark the days you can't be on call. Your teammates can see your notes, which helps when
          partial cover needs to be negotiated.
        </Text>
      </div>

      {openRotas.length > 0 && (
        <Stack gap="xs">
          {openRotas.map((r) => (
            <DatesRequestCard key={r.id} rota={r} highlighted={r.id === focus?.id} />
          ))}
        </Stack>
      )}

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, lg: 9 }}>
          <Card padding="md">
            <AvailabilityCalendar
              entries={entries.data ?? []}
              highlights={highlights}
              onCallDates={onCallDates}
              initialMonth={focus?.start_date}
              saving={save.isPending}
              onApply={(dates, kind, note) => save.mutateAsync({ dates, kind, note })}
            />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 3 }}>
          <Card padding="md">
            <Text fw={700} mb="xs">
              Upcoming marked days
            </Text>
            {upcoming.length === 0 && (
              <Text size="sm" c="dimmed">
                None yet — you're available every day.
              </Text>
            )}
            <Stack gap={6}>
              {groupByKindAndNote(upcoming).map((run) => (
                <Group key={run[0].date} justify="space-between" wrap="nowrap" align="flex-start">
                  <div>
                    <Group gap={6}>
                      <Badge
                        size="xs"
                        color={run[0].kind === 'unavailable' ? 'red' : 'orange'}
                        variant="light"
                      >
                        {run[0].kind === 'unavailable' ? "Can't" : 'Partly'}
                      </Badge>
                      <Text size="sm">{fmtDateRange(run[0].date, run[run.length - 1].date)}</Text>
                    </Group>
                    {run[0].note && (
                      <Text size="xs" c="dimmed">
                        {run[0].note}
                      </Text>
                    )}
                  </div>
                  <Tooltip label="Remove">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      onClick={() =>
                        save.mutate({ dates: run.map((e) => e.date), kind: null, note: '' })
                      }
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function groupByKindAndNote(items: Unavailability[]): Unavailability[][] {
  const out: Unavailability[][] = [];
  for (const run of groupRuns(items)) {
    let cur: Unavailability[] = [];
    for (const e of run) {
      if (cur.length && (cur[0].kind !== e.kind || cur[0].note !== e.note)) {
        out.push(cur);
        cur = [];
      }
      cur.push(e);
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

function DatesRequestCard({ rota, highlighted }: { rota: Rota; highlighted: boolean }) {
  const submit = useAction(() => api(`/api/rotas/${rota.id}/submit`, { body: { comment: '' } }), {
    invalidate: [keys.todo, keys.rota(rota.id), keys.rotas(rota.team_id)],
    success: 'Thanks! Your dates are confirmed. You can still change them until the rota is generated.',
  });
  const withdraw = useAction(
    () => api(`/api/rotas/${rota.id}/submit`, { method: 'DELETE' }),
    { invalidate: [keys.todo, keys.rota(rota.id)] },
  );
  const overdue =
    rota.availability_deadline && rota.availability_deadline < dayjs().format(ISO) && !rota.my_submitted;
  return (
    <Alert
      color={rota.my_submitted ? 'gator' : overdue ? 'red' : 'blue'}
      variant={highlighted ? 'light' : 'outline'}
      icon={rota.my_submitted ? <IconCheck /> : <IconInfoCircle />}
      title={`${rota.team_name}: dates needed for ${fmtDateRange(rota.start_date, rota.end_date)}`}
    >
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          {rota.availability_deadline && (
            <Text size="sm">
              Please respond by <b>{fmtDateLong(rota.availability_deadline)}</b>
              {overdue ? ' (overdue)' : ''}.
            </Text>
          )}
          {rota.request_message && (
            <Text size="sm" fs="italic">
              “{rota.request_message}”
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {rota.submitted_count} of {rota.eligible_count} people have confirmed
            {rota.requested_at ? ` · requested ${fromNow(rota.requested_at)}` : ''}
          </Text>
        </Stack>
        {rota.my_submitted ? (
          <Group gap="xs">
            <Badge color="gator" leftSection={<IconCheck size={12} />}>
              Confirmed
            </Badge>
            <Button size="xs" variant="subtle" onClick={() => withdraw.mutate(undefined)}>
              Undo
            </Button>
          </Group>
        ) : (
          <Button onClick={() => submit.mutate(undefined)} loading={submit.isPending}>
            Confirm my dates
          </Button>
        )}
      </Group>
    </Alert>
  );
}
