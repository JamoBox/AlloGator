import { Badge, Button, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArrowsExchange } from '@tabler/icons-react';
import type { RotaDetail, ScheduleShift } from '../../api/types';
import { dayjs, fmtDateRange, fmtDateTime } from '../../lib/dates';
import { PersonChip } from '../common';

/** One card per period: who's on call, and any partial cover within it. */
export function PeriodsList({
  rota,
  meId,
  myShifts,
  onRequestSwap,
}: {
  rota: RotaDetail;
  meId?: number;
  myShifts: ScheduleShift[];
  onRequestSwap?: (shift: ScheduleShift) => void;
}) {
  const people = new Map(rota.people.map((p) => [p.id, p]));
  const now = dayjs();
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="sm">
      {rota.periods.map((p) => {
        const shifts = rota.shifts.filter((s) => s.period_index === p.index);
        const owner = p.owner_id != null ? people.get(p.owner_id) : null;
        const others = shifts.filter((s) => s.user_id !== p.owner_id);
        const current = dayjs(p.start_at).isBefore(now) && dayjs(p.end_at).isAfter(now);
        const past = dayjs(p.end_at).isBefore(now);
        const mine = shifts.some((s) => s.user_id === meId);
        const myShift = myShifts.find(
          (s) => s.rota_id === rota.id && s.period_index === p.index && dayjs(s.end_at).isAfter(now),
        );
        return (
          <Card
            key={p.index}
            padding="sm"
            style={{
              opacity: past ? 0.6 : 1,
              borderColor: current ? 'var(--mantine-color-gator-6)' : mine ? 'var(--mantine-color-blue-4)' : undefined,
              borderWidth: current || mine ? 2 : 1,
            }}
          >
            <Group justify="space-between" mb={6}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                Period {p.index + 1}
              </Text>
              {current && (
                <Badge size="xs" color="gator">
                  now
                </Badge>
              )}
            </Group>
            <Text size="sm" fw={600}>
              {fmtDateRange(p.start_date, p.end_date)}
            </Text>
            <Stack gap={4} mt="xs">
              {rota.shifts_visible ? (
                <>
                  <PersonChip user={owner ?? null} size="md" />
                  {others.map((s) => (
                    <Group key={s.id} gap={4} wrap="nowrap">
                      <Text size="xs" c={s.user_id == null ? 'red' : 'orange'}>
                        {s.user_id == null ? 'Uncovered' : 'Cover'}:
                      </Text>
                      {s.user_id != null && <PersonChip user={people.get(s.user_id) ?? null} size="xs" />}
                      <Text size="xs" c="dimmed">
                        {fmtDateTime(s.start_at, rota.timezone)} → {fmtDateTime(s.end_at, rota.timezone)}
                      </Text>
                    </Group>
                  ))}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  Not published yet
                </Text>
              )}
            </Stack>
            {myShift && onRequestSwap && rota.status === 'published' && (
              <Button
                size="compact-xs"
                variant="subtle"
                mt="xs"
                leftSection={<IconArrowsExchange size={14} />}
                onClick={() => onRequestSwap(myShift)}
              >
                Request swap
              </Button>
            )}
          </Card>
        );
      })}
    </SimpleGrid>
  );
}
