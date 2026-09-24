import { Avatar, Group, Menu, ScrollArea, Switch, Text, Tooltip } from '@mantine/core';
import {
  IconCalendarEvent,
  IconCheck,
  IconClock,
  IconLock,
  IconLockOpen,
  IconUserOff,
  IconUsers,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { AvailabilityMatrix, Day, RotaDetail, User } from '../../api/types';
import { dayjs, inTz } from '../../lib/dates';
import { initials, personColor } from '../../lib/people';

export interface BoardActions {
  assignDay: (userId: number | null, date: string) => void;
  assignPeriod: (userId: number | null, periodIndex: number) => void;
  customRange: (userId: number | null, day: Day) => void;
  toggleLock: (day: Day) => void;
}

interface Props {
  rota: RotaDetail;
  matrix?: AvailabilityMatrix;
  editable: boolean;
  actions?: BoardActions;
  highlightUserId?: number;
}

type Entry = { kind: 'unavailable' | 'partial'; note: string };

export function RotaBoard({ rota, matrix, editable, actions, highlightUserId }: Props) {
  const [showAll, setShowAll] = useState(false);
  const people = useMemo(() => new Map(rota.people.map((p) => [p.id, p])), [rota.people]);
  const entries = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of matrix?.entries ?? []) m.set(`${e.user_id}:${e.date}`, e);
    return m;
  }, [matrix]);

  const members = matrix?.members ?? [];
  const assignedIds = new Set(rota.days.flatMap((d) => d.user_ids).filter((x): x is number => x != null));
  const rows = members.filter((m) => showAll || m.on_call || assignedIds.has(m.user.id));
  // People on the schedule who are no longer members.
  const extra = [...assignedIds]
    .filter((id) => !members.some((m) => m.user.id === id))
    .map((id) => people.get(id))
    .filter((u): u is User => !!u);
  const hiddenCount = members.length - rows.length;

  const periodStart = new Set(rota.periods.map((p) => p.start_date));
  const showAssignments = rota.shifts_visible && rota.days.some((d) => d.user_ids.some((u) => u != null));

  return (
    <div>
      <ScrollArea type="auto" offsetScrollbars>
        <table className="ag-board">
          <thead>
            <tr>
              <th className="ag-name" />
              {rota.periods.map((p) => (
                <th key={p.index} colSpan={rota.period_days} className="ag-period-start" style={{ padding: '2px 4px' }}>
                  <Text size="xs" fw={700} truncate>
                    {rota.period_days >= 3 ? `P${p.index + 1} · ${dayjs(p.start_date).format('D MMM')}` : `P${p.index + 1}`}
                  </Text>
                </th>
              ))}
            </tr>
            <tr>
              <th className="ag-name">
                <Text size="xs" c="dimmed">
                  {dayjs(rota.start_date).format('MMM YYYY')}
                </Text>
              </th>
              {rota.days.map((d) => {
                const dj = dayjs(d.date);
                return (
                  <th
                    key={d.date}
                    className={periodStart.has(d.date) ? 'ag-period-start' : undefined}
                    data-weekend={dj.day() === 0 || dj.day() === 6 || undefined}
                  >
                    <div style={{ lineHeight: 1.1, padding: '2px 0' }}>
                      <div style={{ fontSize: 9, color: 'var(--mantine-color-dimmed)' }}>{dj.format('dd')[0]}</div>
                      <div>{dj.date()}</div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {showAssignments && (
              <tr className="ag-oncall-row">
                <td className="ag-name">
                  <Text size="xs" fw={700}>
                    On call
                  </Text>
                </td>
                {rota.days.map((d) => (
                  <OnCallCell
                    key={d.date}
                    day={d}
                    people={people}
                    periodStart={periodStart.has(d.date)}
                    editable={editable}
                    actions={actions}
                    candidates={rows.map((r) => r.user)}
                    entries={entries}
                  />
                ))}
              </tr>
            )}
            {[...rows.map((r) => ({ user: r.user, submitted: r.submitted_at, onCall: r.on_call })),
              ...extra.map((u) => ({ user: u, submitted: null, onCall: false }))].map(({ user, submitted, onCall }) => (
              <tr key={user.id}>
                <td
                  className="ag-name"
                  style={user.id === highlightUserId ? { boxShadow: 'inset 3px 0 0 var(--mantine-color-gator-6)' } : undefined}
                >
                  <Group gap={6} wrap="nowrap">
                    <Avatar size={20} radius="xl" color={personColor(user.id)}>
                      <Text fz={9} fw={700}>
                        {initials(user.name)}
                      </Text>
                    </Avatar>
                    <Text
                      size="xs"
                      truncate
                      c={onCall ? undefined : 'dimmed'}
                      fw={user.id === highlightUserId ? 700 : undefined}
                      style={{ maxWidth: 120 }}
                    >
                      {user.name}
                    </Text>
                    {submitted && (
                      <Tooltip label={`Confirmed dates ${inTz(submitted).format('D MMM HH:mm')}`}>
                        <IconCheck size={12} color="var(--mantine-color-gator-6)" />
                      </Tooltip>
                    )}
                  </Group>
                </td>
                {rota.days.map((d) => {
                  const entry = entries.get(`${user.id}:${d.date}`);
                  const assigned = showAssignments && d.user_ids.includes(user.id);
                  const partOfDay = assigned && d.user_ids.length > 1;
                  const dj = dayjs(d.date);
                  const tip = [
                    `${user.name} · ${dj.format('ddd D MMM')}`,
                    entry ? `${entry.kind === 'unavailable' ? "Can't cover" : 'Partly available'}${entry.note ? `: ${entry.note}` : ''}` : 'Available',
                    assigned ? (partOfDay ? 'On call for part of this day' : 'On call') : null,
                  ]
                    .filter(Boolean)
                    .join('\n');
                  const cell = (
                    <td
                      key={d.date}
                      className={`ag-cell${periodStart.has(d.date) ? ' ag-period-start' : ''}`}
                      data-kind={entry?.kind}
                      data-weekend={dj.day() === 0 || dj.day() === 6 || undefined}
                      data-clickable={editable || undefined}
                    >
                      {assigned && (
                        <div
                          className="ag-cell-fill"
                          data-conflict={entry?.kind === 'unavailable' || undefined}
                          data-limited={entry?.kind === 'partial' || undefined}
                          style={{
                            background: `var(--mantine-color-${personColor(user.id)}-${partOfDay ? 3 : 6})`,
                          }}
                        />
                      )}
                      {entry?.note && !assigned && (
                        <span
                          className="ag-dot"
                          style={{ background: 'var(--mantine-color-dimmed)', position: 'absolute', top: 3, right: 3 }}
                        />
                      )}
                    </td>
                  );
                  const withTip = (
                    <Tooltip key={d.date} label={tip} withArrow openDelay={200} style={{ whiteSpace: 'pre-line' }}>
                      {cell}
                    </Tooltip>
                  );
                  if (!editable || !actions) return withTip;
                  return (
                    <Menu key={d.date} withArrow position="bottom" shadow="md" withinPortal>
                      <Menu.Target>{withTip}</Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Label>
                          {user.name} · {dj.format('ddd D MMM')}
                        </Menu.Label>
                        <Menu.Item leftSection={<IconCalendarEvent size={16} />} onClick={() => actions.assignDay(user.id, d.date)}>
                          On call for this day
                        </Menu.Item>
                        <Menu.Item leftSection={<IconUsers size={16} />} onClick={() => actions.assignPeriod(user.id, d.period_index)}>
                          On call for all of period {d.period_index + 1}
                        </Menu.Item>
                        <Menu.Item leftSection={<IconClock size={16} />} onClick={() => actions.customRange(user.id, d)}>
                          Custom time range…
                        </Menu.Item>
                        {entry && (
                          <Menu.Label c={entry.kind === 'unavailable' ? 'red' : 'orange'}>
                            {entry.kind === 'unavailable' ? "Marked as can't cover" : 'Marked as partly available'}
                            {entry.note ? `: ${entry.note}` : ''}
                          </Menu.Label>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      <Group justify="space-between" mt="xs">
        <BoardLegend />
        {hiddenCount > 0 || showAll ? (
          <Switch
            size="xs"
            label={`Show people not on call${hiddenCount ? ` (${hiddenCount})` : ''}`}
            checked={showAll}
            onChange={(e) => setShowAll(e.currentTarget.checked)}
          />
        ) : null}
      </Group>
    </div>
  );
}

function OnCallCell({
  day,
  people,
  periodStart,
  editable,
  actions,
  candidates,
  entries,
}: {
  day: Day;
  people: Map<number, User>;
  periodStart: boolean;
  editable: boolean;
  actions?: BoardActions;
  candidates: User[];
  entries: Map<string, Entry>;
}) {
  const uncovered = day.user_ids.includes(null) || day.user_ids.length === 0;
  const user = day.majority != null ? people.get(day.majority) : undefined;
  const split = day.user_ids.length > 1;
  const tip = [
    dayjs(day.date).format('ddd D MMM'),
    uncovered && day.user_ids.length <= 1
      ? 'Nobody on call'
      : day.user_ids.map((id) => (id == null ? 'Nobody (part of day)' : people.get(id)?.name ?? '?')).join(' + '),
    day.locked ? 'Pinned (kept when regenerating)' : null,
  ]
    .filter(Boolean)
    .join('\n');

  const cell = (
    <td
      className={`ag-cell${periodStart ? ' ag-period-start' : ''}${uncovered && !user ? ' ag-uncovered' : ''}`}
      data-clickable={editable || undefined}
      style={
        user
          ? {
              background: `var(--mantine-color-${personColor(user.id)}-filled)`,
              color: 'white',
              fontWeight: 700,
              fontSize: 9,
              boxShadow: split || uncovered ? 'inset 0 -4px 0 var(--ag-unavailable-strong)' : undefined,
            }
          : undefined
      }
    >
      {user ? initials(user.name) : '!'}
      {day.locked && (
        <IconLock size={8} style={{ position: 'absolute', top: 1, right: 1, opacity: 0.85 }} />
      )}
    </td>
  );
  const withTip = (
    <Tooltip label={tip} withArrow style={{ whiteSpace: 'pre-line' }}>
      {cell}
    </Tooltip>
  );
  if (!editable || !actions) return withTip;
  const sorted = [...candidates].sort((a, b) => rank(a.id) - rank(b.id));
  function rank(id: number) {
    const e = entries.get(`${id}:${day.date}`);
    return e ? (e.kind === 'partial' ? 1 : 2) : 0;
  }
  return (
    <Menu withArrow position="bottom" shadow="md" withinPortal>
      <Menu.Target>{withTip}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Who's on call {dayjs(day.date).format('ddd D MMM')}?</Menu.Label>
        {sorted.map((u) => {
          const e = entries.get(`${u.id}:${day.date}`);
          return (
            <Menu.Item
              key={u.id}
              onClick={() => actions.assignDay(u.id, day.date)}
              leftSection={
                <Avatar size={18} radius="xl" color={personColor(u.id)}>
                  <Text fz={8}>{initials(u.name)}</Text>
                </Avatar>
              }
              rightSection={
                e ? (
                  <Text size="xs" c={e.kind === 'unavailable' ? 'red' : 'orange'}>
                    {e.kind === 'unavailable' ? "can't" : 'partly'}
                  </Text>
                ) : null
              }
            >
              {u.name}
            </Menu.Item>
          );
        })}
        <Menu.Divider />
        <Menu.Item leftSection={<IconUserOff size={16} />} color="red" onClick={() => actions.assignDay(null, day.date)}>
          Leave uncovered
        </Menu.Item>
        <Menu.Item
          leftSection={day.locked ? <IconLockOpen size={16} /> : <IconLock size={16} />}
          onClick={() => actions.toggleLock(day)}
        >
          {day.locked ? 'Unpin' : 'Pin (keep when regenerating)'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function BoardLegend() {
  const sw = (style: React.CSSProperties, label: string) => (
    <Group gap={4} wrap="nowrap">
      <span className="ag-legend-swatch" style={style} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
  return (
    <Group gap="md">
      {sw({ background: 'var(--mantine-color-blue-6)' }, 'On call')}
      {sw(
        {
          background:
            'repeating-linear-gradient(135deg, var(--ag-unavailable), var(--ag-unavailable) 3px, transparent 3px, transparent 5px)',
        },
        "Can't cover",
      )}
      {sw({ background: 'var(--ag-partial)' }, 'Partly available')}
      {sw({ background: 'var(--mantine-color-blue-6)', boxShadow: '0 0 0 2px var(--ag-unavailable-strong)' }, 'Conflict')}
      {sw({ background: 'var(--ag-unavailable-strong)' }, 'Uncovered')}
      <Group gap={4}>
        <IconLock size={12} />
        <Text size="xs" c="dimmed">
          Pinned
        </Text>
      </Group>
    </Group>
  );
}
