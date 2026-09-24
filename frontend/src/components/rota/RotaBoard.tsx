import { Avatar, Group, Menu, ScrollArea, Switch, Text } from '@mantine/core';
import {
  IconBulb,
  IconCalendarEvent,
  IconClock,
  IconLock,
  IconLockOpen,
  IconUserOff,
  IconUsers,
} from '@tabler/icons-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { AvailabilityMatrix, Day, RotaDetail, User } from '../../api/types';
import { dayjs, inTz } from '../../lib/dates';
import { initials, personColor } from '../../lib/people';
import { HoverTip, type HoverTipHandle } from '../HoverTip';

export interface BoardActions {
  assignDay: (userId: number | null, date: string) => void;
  assignPeriod: (userId: number | null, periodIndex: number) => void;
  customRange: (userId: number | null, day: Day) => void;
  toggleLock: (day: Day) => void;
  helpDecide?: (day: Day) => void;
}

interface Props {
  rota: RotaDetail;
  matrix?: AvailabilityMatrix;
  editable: boolean;
  actions?: BoardActions;
  highlightUserId?: number;
}

type Entry = { kind: 'unavailable' | 'partial'; note: string };
type MenuState = { userId: number | null; oncall: boolean; date: string; rect: DOMRect };

/**
 * People x days grid: availability (hatched = can't, orange = partly), who's on call (filled),
 * and an "On call" summary row. Built for speed: the table is memoised and uses plain cells;
 * a single tooltip and a single action menu are shared by every cell via event delegation.
 */
export function RotaBoard({ rota, matrix, editable, actions, highlightUserId }: Props) {
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const tip = useRef<HoverTipHandle>(null);

  const members = matrix?.members ?? [];
  const assignedIds = useMemo(
    () => new Set(rota.days.flatMap((d) => d.user_ids).filter((x): x is number => x != null)),
    [rota.days],
  );
  const hiddenCount = members.filter((m) => !(m.on_call || assignedIds.has(m.user.id))).length;

  const editableRef = useRef(editable);
  editableRef.current = editable;

  const onClick = useCallback((e: React.MouseEvent) => {
    const cell = cellFrom(e.target);
    if (!cell || !editableRef.current || cell.dataset.u === 'header') return;
    tip.current?.hide();
    const u = cell.dataset.u!;
    setMenu({
      userId: u === 'oncall' ? null : Number(u),
      oncall: u === 'oncall',
      date: cell.dataset.d!,
      rect: cell.getBoundingClientRect(),
    });
  }, []);

  const onOver = useCallback((e: React.MouseEvent) => {
    const cell = cellFrom(e.target);
    if (cell?.dataset.tip) tip.current?.show(cell.dataset.tip, cell.getBoundingClientRect());
    else tip.current?.hide();
  }, []);
  const onLeave = useCallback(() => tip.current?.hide(), []);

  return (
    <div>
      <ScrollArea
        type="auto"
        offsetScrollbars
        onScrollPositionChange={() => {
          tip.current?.hide();
          setMenu(null);
        }}
      >
        <BoardTable
          rota={rota}
          matrix={matrix}
          showAll={showAll}
          highlightUserId={highlightUserId}
          editable={editable}
          onClick={onClick}
          onOver={onOver}
          onLeave={onLeave}
        />
      </ScrollArea>
      <HoverTip ref={tip} />
      {editable && actions && menu && (
        <CellMenu
          key={`${menu.oncall ? 'oncall' : menu.userId}-${menu.date}`}
          state={menu}
          rota={rota}
          matrix={matrix}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
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

function cellFrom(target: EventTarget | null) {
  return (target as HTMLElement | null)?.closest<HTMLElement>('[data-d]') ?? null;
}

// --- The table (memoised; re-renders only when its data changes) ----------------------------

const BoardTable = memo(function BoardTable({
  rota,
  matrix,
  showAll,
  highlightUserId,
  editable,
  onClick,
  onOver,
  onLeave,
}: {
  rota: RotaDetail;
  matrix?: AvailabilityMatrix;
  showAll: boolean;
  highlightUserId?: number;
  editable: boolean;
  onClick: (e: React.MouseEvent) => void;
  onOver: (e: React.MouseEvent) => void;
  onLeave: () => void;
}) {
  const people = useMemo(() => new Map(rota.people.map((p) => [p.id, p])), [rota.people]);
  const entries = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of matrix?.entries ?? []) m.set(`${e.user_id}:${e.date}`, e);
    return m;
  }, [matrix]);
  const members = matrix?.members ?? [];
  const assignedIds = new Set(
    rota.days.flatMap((d) => d.user_ids).filter((x): x is number => x != null),
  );
  const rows = [
    ...members
      .filter((m) => showAll || m.on_call || assignedIds.has(m.user.id))
      .map((m) => ({ user: m.user, submitted: m.submitted_at, onCall: m.on_call })),
    ...[...assignedIds]
      .filter((id) => !members.some((m) => m.user.id === id))
      .map((id) => people.get(id))
      .filter((u): u is User => !!u)
      .map((u) => ({ user: u, submitted: null as string | null, onCall: false })),
  ];
  const periodStart = new Set(rota.periods.map((p) => p.start_date));
  const showAssignments = rota.shifts_visible && assignedIds.size > 0;
  const clickable = editable || undefined;
  const dayInfo = rota.days.map((d) => {
    const dj = dayjs(d.date);
    return {
      d,
      dj,
      label: dj.format('ddd D MMM') + (d.holiday ? ` · 🎉 ${d.holiday}` : ''),
      weekend: dj.day() === 0 || dj.day() === 6 || undefined,
      start: periodStart.has(d.date),
    };
  });

  return (
    <table className="ag-board" onClick={onClick} onMouseOver={onOver} onMouseLeave={onLeave}>
      <thead>
        <tr>
          <th className="ag-name" />
          {rota.periods.map((p) => (
            <th
              key={p.index}
              colSpan={rota.period_days}
              className="ag-period-start"
              style={{ padding: '2px 4px' }}
            >
              <Text size="xs" fw={700} truncate>
                {rota.period_days >= 3
                  ? `P${p.index + 1} · ${dayjs(p.start_date).format('D MMM')}`
                  : `P${p.index + 1}`}
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
          {dayInfo.map(({ d, dj, weekend, start, label }) => (
            <th
              key={d.date}
              className={start ? 'ag-period-start' : undefined}
              data-weekend={weekend}
              data-holiday={d.holiday ? true : undefined}
              data-d={d.holiday ? d.date : undefined}
              data-u={d.holiday ? 'header' : undefined}
              data-tip={d.holiday ? label : undefined}
            >
              <div style={{ lineHeight: 1.1, padding: '2px 0' }}>
                <div style={{ fontSize: 9, color: 'var(--mantine-color-dimmed)' }}>
                  {dj.format('dd')[0]}
                </div>
                <div>{dj.date()}</div>
              </div>
            </th>
          ))}
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
            {dayInfo.map(({ d, start, label }) => {
              const uncovered = d.user_ids.includes(null) || d.user_ids.length === 0;
              const user = d.majority != null ? people.get(d.majority) : undefined;
              const split = d.user_ids.length > 1;
              const who =
                uncovered && d.user_ids.length <= 1
                  ? 'Nobody on call'
                  : d.user_ids
                      .map((id) => (id == null ? 'Nobody (part of day)' : (people.get(id)?.name ?? '?')))
                      .join(' + ');
              const tipText = [label, who, d.locked ? '📌 Pinned (kept when regenerating)' : null]
                .filter(Boolean)
                .join('\n');
              return (
                <td
                  key={d.date}
                  className={`ag-cell${start ? ' ag-period-start' : ''}${uncovered && !user ? ' ag-uncovered' : ''}`}
                  data-u="oncall"
                  data-d={d.date}
                  data-tip={tipText}
                  data-clickable={clickable}
                  style={
                    user
                      ? {
                          background: `var(--mantine-color-${personColor(user.id)}-filled)`,
                          color: 'white',
                          fontWeight: 700,
                          fontSize: 9,
                          boxShadow:
                            split || uncovered
                              ? 'inset 0 -4px 0 var(--ag-unavailable-strong)'
                              : undefined,
                        }
                      : undefined
                  }
                >
                  {user ? initials(user.name) : '!'}
                  {d.locked && <span className="ag-pin" />}
                </td>
              );
            })}
          </tr>
        )}
        {rows.map(({ user, submitted, onCall }) => {
          const cells: PersonCell[] = dayInfo.map(({ d, weekend, start, label }) => {
            const entry = entries.get(`${user.id}:${d.date}`);
            const assigned = showAssignments && d.user_ids.includes(user.id);
            return {
              date: d.date,
              label,
              weekend,
              start,
              kind: entry?.kind,
              note: entry?.note ?? '',
              assigned: assigned ? (d.user_ids.length > 1 ? 2 : 1) : 0,
            };
          });
          const props = {
            userId: user.id,
            name: user.name,
            submitted,
            onCall,
            me: user.id === highlightUserId,
            clickable: !!clickable,
          };
          return <PersonRow key={user.id} {...props} cells={cells} sig={rowSig(props, cells)} />;
        })}
      </tbody>
    </table>
  );
});

// --- One memoised row per person: only rows whose cells changed re-render --------------------

interface PersonCell {
  date: string;
  label: string;
  weekend?: true;
  start: boolean;
  kind?: 'unavailable' | 'partial';
  note: string;
  assigned: 0 | 1 | 2; // 2 = part of the day
}

interface PersonRowProps {
  userId: number;
  name: string;
  submitted: string | null;
  onCall: boolean;
  me: boolean;
  clickable: boolean;
}

function rowSig(p: PersonRowProps, cells: PersonCell[]): string {
  return (
    `${p.userId}|${p.name}|${p.submitted}|${p.onCall}|${p.me}|${p.clickable}#` +
    cells.map((c) => `${c.date}${c.kind ?? ''}${c.assigned}${c.start ? 's' : ''}${c.note}${c.label}`).join(';')
  );
}

const PersonRow = memo(
  function PersonRow({
    userId,
    name,
    submitted,
    onCall,
    me,
    clickable,
    cells,
  }: PersonRowProps & { cells: PersonCell[]; sig: string }) {
    return (
      <tr>
        <td
          className="ag-name"
          style={me ? { boxShadow: 'inset 3px 0 0 var(--mantine-color-gator-6)' } : undefined}
        >
          <Group gap={6} wrap="nowrap">
            <Avatar size={20} radius="xl" color={personColor(userId)}>
              <Text fz={9} fw={700}>
                {initials(name)}
              </Text>
            </Avatar>
            <Text
              size="xs"
              truncate
              c={onCall ? undefined : 'dimmed'}
              fw={me ? 700 : undefined}
              style={{ maxWidth: 120 }}
            >
              {name}
            </Text>
            {submitted && (
              <span
                className="ag-check"
                title={`Confirmed dates ${inTz(submitted).format('D MMM HH:mm')}`}
                aria-label="Dates confirmed"
              >
                ✓
              </span>
            )}
          </Group>
        </td>
        {cells.map((c) => {
          const tipText = [
            `${name} · ${c.label}`,
            c.kind
              ? `${c.kind === 'unavailable' ? "Can't cover" : 'Partly available'}${c.note ? `: ${c.note}` : ''}`
              : 'Available',
            c.assigned === 2 ? 'On call for part of this day' : c.assigned ? 'On call' : null,
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <td
              key={c.date}
              className={`ag-cell${c.start ? ' ag-period-start' : ''}`}
              data-u={userId}
              data-d={c.date}
              data-tip={tipText}
              data-kind={c.kind}
              data-weekend={c.weekend}
              data-clickable={clickable || undefined}
            >
              {c.assigned > 0 && (
                <div
                  className="ag-cell-fill"
                  data-conflict={c.kind === 'unavailable' || undefined}
                  data-limited={c.kind === 'partial' || undefined}
                  style={{
                    background: `var(--mantine-color-${personColor(userId)}-${c.assigned === 2 ? 3 : 6})`,
                  }}
                />
              )}
              {c.note && !c.assigned && <span className="ag-dot ag-note-dot" />}
            </td>
          );
        })}
      </tr>
    );
  },
  (a, b) => a.sig === b.sig,
);

// --- One action menu, anchored to whichever cell was clicked -----------------------------------

function CellMenu({
  state,
  rota,
  matrix,
  actions,
  onClose,
}: {
  state: MenuState;
  rota: RotaDetail;
  matrix?: AvailabilityMatrix;
  actions: BoardActions;
  onClose: () => void;
}) {
  const day = rota.days.find((d) => d.date === state.date);
  if (!day) return null;
  const label = dayjs(day.date).format('ddd D MMM');
  const entryFor = (uid: number) =>
    matrix?.entries.find((e) => e.user_id === uid && e.date === day.date);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const { rect } = state;

  let content: React.ReactNode;
  if (state.oncall) {
    const candidates = (matrix?.members ?? []).filter((m) => m.on_call).map((m) => m.user);
    const rank = (id: number) => {
      const e = entryFor(id);
      return e ? (e.kind === 'partial' ? 1 : 2) : 0;
    };
    content = (
      <>
        <Menu.Label>
          Who's on call {label}?{day.holiday ? ` 🎉 ${day.holiday}` : ''}
        </Menu.Label>
        {actions.helpDecide && (
          <Menu.Item
            leftSection={<IconBulb size={16} />}
            color="grape"
            onClick={run(() => actions.helpDecide!(day))}
          >
            Help me decide…
          </Menu.Item>
        )}
        {[...candidates]
          .sort((a, b) => rank(a.id) - rank(b.id))
          .map((u) => {
            const e = entryFor(u.id);
            return (
              <Menu.Item
                key={u.id}
                onClick={run(() => actions.assignDay(u.id, day.date))}
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
        <Menu.Item
          leftSection={<IconUserOff size={16} />}
          color="red"
          onClick={run(() => actions.assignDay(null, day.date))}
        >
          Leave uncovered
        </Menu.Item>
        <Menu.Item
          leftSection={day.locked ? <IconLockOpen size={16} /> : <IconLock size={16} />}
          onClick={run(() => actions.toggleLock(day))}
        >
          {day.locked ? 'Unpin' : 'Pin (keep when regenerating)'}
        </Menu.Item>
      </>
    );
  } else if (state.userId != null) {
    const uid = state.userId;
    const person = rota.people.find((p) => p.id === uid);
    const entry = entryFor(uid);
    content = (
      <>
        <Menu.Label>
          {person?.name} · {label}
          {day.holiday ? ` 🎉 ${day.holiday}` : ''}
        </Menu.Label>
        <Menu.Item
          leftSection={<IconCalendarEvent size={16} />}
          onClick={run(() => actions.assignDay(uid, day.date))}
        >
          On call for this day
        </Menu.Item>
        <Menu.Item
          leftSection={<IconUsers size={16} />}
          onClick={run(() => actions.assignPeriod(uid, day.period_index))}
        >
          On call for all of period {day.period_index + 1}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconClock size={16} />}
          onClick={run(() => actions.customRange(uid, day))}
        >
          Custom time range…
        </Menu.Item>
        {actions.helpDecide && (
          <Menu.Item leftSection={<IconBulb size={16} />} onClick={run(() => actions.helpDecide!(day))}>
            Who should take {label}?
          </Menu.Item>
        )}
        {entry && (
          <Menu.Label c={entry.kind === 'unavailable' ? 'red' : 'orange'}>
            {entry.kind === 'unavailable' ? "Marked as can't cover" : 'Marked as partly available'}
            {entry.note ? `: ${entry.note}` : ''}
          </Menu.Label>
        )}
      </>
    );
  } else {
    return null;
  }

  return (
    <Menu
      opened
      onChange={(o) => !o && onClose()}
      withArrow
      position="bottom"
      shadow="md"
      withinPortal
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <div
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            pointerEvents: 'none',
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>{content}</Menu.Dropdown>
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
      {sw(
        { background: 'var(--mantine-color-blue-6)', boxShadow: '0 0 0 2px var(--ag-unavailable-strong)' },
        'Conflict',
      )}
      {sw({ background: 'var(--ag-unavailable-strong)' }, 'Uncovered')}
      <Group gap={4} wrap="nowrap">
        <span className="ag-holiday-dot" />
        <Text size="xs" c="dimmed">
          Holiday / special day
        </Text>
      </Group>
      <Group gap={4} wrap="nowrap">
        <span className="ag-pin" style={{ position: 'static', background: 'var(--mantine-color-dimmed)' }} />
        <Text size="xs" c="dimmed">
          Pinned
        </Text>
      </Group>
    </Group>
  );
}
