import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconArrowBackUp, IconBan, IconClockHour4, IconEraser, IconMessage } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { AvailabilityChange, AvailabilityMatrix, RotaDetail } from '../../api/types';
import { DayPickCalendar } from '../DayPickCalendar';

/** A leader marks, clears or resets one person's availability over several days of the rota. */
export function MemberAvailabilityForm({
  rota,
  matrix,
  userId,
  date,
  onApply,
}: {
  rota: RotaDetail;
  matrix?: AvailabilityMatrix;
  userId: number;
  date: string;
  onApply: (dates: string[], change: AvailabilityChange, note: string) => void;
}) {
  const [selected, setSelected] = useState(() => new Set([date]));
  const [note, setNote] = useState('');

  const pickable = useMemo(
    () => new Map(rota.days.map((d) => [d.date, d.holiday ? `🎉 ${d.holiday}` : ''])),
    [rota.days],
  );
  const mine = useMemo(() => {
    const m = new Map<string, { kind: 'unavailable' | 'partial'; tip: string }>();
    for (const e of matrix?.entries ?? [])
      if (e.user_id === userId)
        m.set(e.date, {
          kind: e.kind,
          tip: `${e.kind === 'unavailable' ? "Can't cover" : 'Partly available'}${e.note ? `: ${e.note}` : ''}${e.set_by ? ` (by ${e.set_by})` : ''}`,
        });
    return m;
  }, [matrix, userId]);
  // Days a leader changed, which can be put back to what the person entered.
  const resettable = useMemo(
    () =>
      new Set([
        ...(matrix?.entries ?? []).filter((e) => e.user_id === userId && e.set_by).map((e) => e.date),
        ...(matrix?.cleared ?? []).filter((c) => c.user_id === userId).map((c) => c.date),
      ]),
    [matrix, userId],
  );

  const dates = [...selected].sort();
  const apply = (change: AvailabilityChange) =>
    onApply(dates, change, change === 'unavailable' || change === 'partial' ? note : '');

  return (
    <Stack gap="sm">
      <DayPickCalendar pickable={pickable} selected={selected} onChange={setSelected} mine={mine} />
      <TextInput
        size="sm"
        leftSection={<IconMessage size={16} />}
        placeholder="Optional note for the team, e.g. “on leave until the 24th”"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          color="red"
          leftSection={<IconBan size={16} />}
          disabled={!dates.length}
          onClick={() => apply('unavailable')}
        >
          Can't cover
        </Button>
        <Button
          color="orange"
          variant="light"
          leftSection={<IconClockHour4 size={16} />}
          disabled={!dates.length}
          onClick={() => apply('partial')}
        >
          Partly available
        </Button>
        <Button
          variant="default"
          leftSection={<IconEraser size={16} />}
          disabled={!dates.some((d) => mine.has(d))}
          onClick={() => apply(null)}
        >
          Clear
        </Button>
        <Button
          variant="default"
          leftSection={<IconArrowBackUp size={16} />}
          disabled={!dates.some((d) => resettable.has(d))}
          onClick={() => apply('reset')}
        >
          Reset to their own
        </Button>
        <Text size="xs" c="dimmed">
          {dates.length} {dates.length === 1 ? 'day' : 'days'} selected
        </Text>
      </Group>
    </Stack>
  );
}
