import {
  ActionIcon,
  Affix,
  Alert,
  Button,
  Group,
  Kbd,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Transition,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconChevronLeft,
  IconChevronRight,
  IconClockHour4,
  IconEraser,
  IconMessage,
  IconPhoneCall,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AvailabilityKind, Unavailability } from '../api/types';
import { dayjs, eachDay, fmtDate, fmtDateRange, groupRuns, ISO } from '../lib/dates';
import { HoverTip, useHoverTip } from './HoverTip';

export interface HighlightRange {
  start: string;
  end: string;
  label: string;
  /** Still waiting for your dates: shaded, not just outlined. */
  pending?: boolean;
}

interface Props {
  entries: Unavailability[];
  highlights?: HighlightRange[];
  onCallDates?: Set<string>;
  specialDays?: Map<string, string>;
  initialMonth?: string;
  months?: number;
  saving?: boolean;
  onApply: (dates: string[], kind: AvailabilityKind | null, note: string) => unknown;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function AvailabilityCalendar({
  entries,
  highlights = [],
  onCallDates,
  specialDays,
  initialMonth,
  months = 3,
  saving,
  onApply,
}: Props) {
  const [month, setMonth] = useState(() => dayjs(initialMonth ?? undefined).startOf('month'));
  useEffect(() => {
    if (initialMonth) setMonth(dayjs(initialMonth).startOf('month'));
  }, [initialMonth]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const drag = useRef<{ anchor: string; base: Set<string> } | null>(null);
  const lastAnchor = useRef<string | null>(null);
  const today = dayjs().format(ISO);
  const hoverTip = useHoverTip();

  const byDate = useMemo(() => new Map(entries.map((e) => [e.date, e])), [entries]);
  const inRota = useMemo(() => {
    const m = new Map<string, { label: string; pending: boolean }>();
    for (const h of highlights)
      for (const d of eachDay(h.start, h.end)) {
        const prev = m.get(d);
        m.set(d, { label: prev ? `${prev.label}, ${h.label}` : h.label, pending: !!h.pending || !!prev?.pending });
      }
    return m;
  }, [highlights]);

  // Pre-fill the note when the selection shares one.
  useEffect(() => {
    const notes = new Set([...selected].map((d) => byDate.get(d)?.note ?? ''));
    setNote(notes.size === 1 ? [...notes][0] : '');
  }, [selected, byDate]);

  const rangeBetween = (a: string, b: string) => (a <= b ? eachDay(a, b) : eachDay(b, a));

  // Taps toggle days (so several separate days are easy to pick on a phone); dragging adds a
  // run of days; shift-click adds everything since the last day picked.
  const begin = (date: string, e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') e.preventDefault();
    if (e.shiftKey && lastAnchor.current) {
      setSelected(new Set([...selected, ...rangeBetween(lastAnchor.current, date)]));
      lastAnchor.current = date;
      return;
    }
    if (selected.has(date)) {
      const next = new Set(selected);
      next.delete(date);
      setSelected(next);
      drag.current = null;
      return;
    }
    drag.current = { anchor: date, base: new Set(selected) };
    lastAnchor.current = date;
    setSelected(new Set([...selected, date]));
  };

  const extend = useCallback((date: string) => {
    const d = drag.current;
    if (!d) return;
    setSelected(new Set([...d.base, ...rangeBetween(d.anchor, date)]));
  }, []);

  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const date = el?.closest<HTMLElement>('[data-date]')?.dataset.date;
    if (date) extend(date);
  };

  const sel = [...selected].sort();
  const selectedOnCall = onCallDates ? sel.filter((d) => onCallDates.has(d)) : [];
  const anyMarked = sel.some((d) => byDate.has(d));

  // Optimistic: the parent updates its cache immediately, so we clear the selection at once.
  const apply = (kind: AvailabilityKind | null) => {
    if (!sel.length) return;
    onApply(sel, kind, kind ? note : '');
    setSelected(new Set());
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Keyboard shortcuts while days are selected: U = can't cover, P = partly, ⌫ = clear.
  const hasSelection = sel.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]');
      if (e.key === 'Escape') {
        (e.target as HTMLElement)?.blur?.();
        setSelected(new Set());
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'u' || k === 'x') applyRef.current('unavailable');
      else if (k === 'p') applyRef.current('partial');
      else if (k === 'backspace' || k === 'delete') applyRef.current(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection]);

  const monthsToShow = Array.from({ length: months }, (_, i) => month.add(i, 'month'));

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Group gap={4}>
          <ActionIcon variant="default" onClick={() => setMonth(month.subtract(1, 'month'))} aria-label="Previous month">
            <IconChevronLeft size={16} />
          </ActionIcon>
          <ActionIcon variant="default" onClick={() => setMonth(month.add(1, 'month'))} aria-label="Next month">
            <IconChevronRight size={16} />
          </ActionIcon>
          <Button variant="subtle" size="compact-sm" onClick={() => setMonth(dayjs().startOf('month'))}>
            Today
          </Button>
        </Group>
        <Legend />
      </Group>
      <Text size="sm" c="dimmed">
        Tap the days you can't do (or drag across a run of days), then choose what applies below.
        Shift-click selects everything in between.
      </Text>

      <SimpleGrid
        cols={{ base: 1, sm: Math.min(2, months), xl: months }}
        spacing="lg"
        className="ag-month"
        onPointerMove={onPointerMove}
        onMouseOver={hoverTip.onMouseOver}
        onMouseLeave={hoverTip.onMouseLeave}
        onPointerDown={hoverTip.hide}
      >
        {monthsToShow.map((m) => (
          <MonthGrid
            key={m.format('YYYY-MM')}
            month={m}
            today={today}
            byDate={byDate}
            inRota={inRota}
            onCallDates={onCallDates}
            specialDays={specialDays}
            selected={selected}
            onPointerDown={begin}
            onPointerEnter={extend}
          />
        ))}
      </SimpleGrid>

      <HoverTip ref={hoverTip.ref} />
      <Affix position={{ bottom: 16, left: 0, right: 0 }} zIndex={150}>
        <Transition transition="slide-up" mounted={sel.length > 0} duration={120} exitDuration={80}>
          {(styles) => (
            <Paper
              shadow="lg"
              withBorder
              p="sm"
              mx="auto"
              maw={760}
              style={{ ...styles, width: 'calc(100% - 24px)' }}
            >
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={600} size="sm">
                    {sel.length === 1
                      ? fmtDate(sel[0])
                      : `${sel.length} days: ${groupRuns(sel.map((date) => ({ date })))
                          .map((r) => fmtDateRange(r[0].date, r[r.length - 1].date))
                          .join(', ')}`}
                  </Text>
                  <Button
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    leftSection={<IconX size={14} />}
                    rightSection={<Kbd size="xs">Esc</Kbd>}
                    onClick={() => setSelected(new Set())}
                  >
                    Deselect all
                  </Button>
                </Group>
                {selectedOnCall.length > 0 && (
                  <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
                    <Text size="xs">
                      You're already on call on {selectedOnCall.map(fmtDate).join(', ')}. Marking it
                      here won't change the published rota — request a swap from your team page.
                    </Text>
                  </Alert>
                )}
                <TextInput
                  size="sm"
                  leftSection={<IconMessage size={16} />}
                  placeholder="Optional note for your team, e.g. “busy 13:00–17:00” or “on holiday”"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.currentTarget.value)}
                />
                <Group gap="xs">
                  <Button
                    color="red"
                    leftSection={<IconBan size={16} />}
                    rightSection={<Kbd size="xs">U</Kbd>}
                    loading={saving}
                    onClick={() => apply('unavailable')}
                  >
                    Can't cover
                  </Button>
                  <Button
                    color="orange"
                    variant="light"
                    leftSection={<IconClockHour4 size={16} />}
                    rightSection={<Kbd size="xs">P</Kbd>}
                    loading={saving}
                    onClick={() => apply('partial')}
                  >
                    Partly available
                  </Button>
                  {anyMarked && (
                    <Button
                      variant="default"
                      leftSection={<IconEraser size={16} />}
                      rightSection={<Kbd size="xs">⌫</Kbd>}
                      loading={saving}
                      onClick={() => apply(null)}
                    >
                      Clear
                    </Button>
                  )}
                </Group>
              </Stack>
            </Paper>
          )}
        </Transition>
      </Affix>
    </Stack>
  );
}

function MonthGrid({
  month,
  today,
  byDate,
  inRota,
  onCallDates,
  specialDays,
  selected,
  onPointerDown,
  onPointerEnter,
}: {
  month: dayjs.Dayjs;
  today: string;
  byDate: Map<string, Unavailability>;
  inRota: Map<string, { label: string; pending: boolean }>;
  onCallDates?: Set<string>;
  specialDays?: Map<string, string>;
  selected: Set<string>;
  onPointerDown: (date: string, e: React.PointerEvent) => void;
  onPointerEnter: (date: string) => void;
}) {
  const first = month.startOf('month');
  const lead = (first.day() + 6) % 7; // Monday-first
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: month.daysInMonth() }, (_, i) => first.add(i, 'day').format(ISO)),
  ];
  while (cells.length % 7) cells.push(null);

  return (
    <div>
      <Text fw={700} mb={6}>
        {month.format('MMMM YYYY')}
      </Text>
      <div className="ag-month-grid">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="ag-weekday">
            {w}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`x${i}`} className="ag-day" data-outside />;
          const entry = byDate.get(date);
          const d = dayjs(date);
          const rota = inRota.get(date);
          const special = specialDays?.get(date);
          const onCall = onCallDates?.has(date);
          const tip = [
            entry
              ? `${entry.kind === 'unavailable' ? "Can't cover" : 'Partly available'}${entry.note ? `: ${entry.note}` : ''}${entry.added_by ? ` (added by ${entry.added_by})` : ''}`
              : null,
            onCall ? "You're on call" : null,
            special ? `🎉 ${special}` : null,
            rota ? `${rota.pending ? 'Your dates are needed' : 'Dates confirmed'}: ${rota.label}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          const cell = (
            <div
              key={date}
              className="ag-day"
              data-date={date}
              data-kind={entry?.kind}
              data-selected={selected.has(date) || undefined}
              data-today={date === today || undefined}
              data-weekend={d.day() === 0 || d.day() === 6 || undefined}
              data-past={date < today || undefined}
              data-in-rota={rota ? (rota.pending ? 'pending' : 'done') : undefined}
              data-special={special ? true : undefined}
              onPointerDown={(e) => onPointerDown(date, e)}
              onPointerEnter={() => onPointerEnter(date)}
              role="button"
              aria-pressed={selected.has(date)}
              aria-label={`${d.format('dddd D MMMM')}${tip ? `. ${tip}` : ''}`}
              data-tip={tip || undefined}
            >
              <span className="ag-day-num">{d.date()}</span>
              <span className="ag-day-flags">
                {entry?.note && <IconMessage size={11} />}
                {onCall && <IconPhoneCall size={11} color="var(--mantine-color-gator-7)" />}
              </span>
            </div>
          );
          return cell;
        })}
      </div>
    </div>
  );
}

function Legend() {
  const item = (style: React.CSSProperties, label: string) => (
    <Group gap={4} wrap="nowrap">
      <span className="ag-legend-swatch" style={style} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
  return (
    <Group gap="md">
      {item({ background: 'var(--ag-unavailable)', borderColor: 'var(--ag-unavailable-strong)' }, "Can't cover")}
      {item(
        { background: 'var(--ag-partial)', borderColor: 'var(--ag-partial-strong)', borderStyle: 'dashed' },
        'Partly available',
      )}
      {item({ background: 'var(--ag-requested)', borderColor: 'var(--ag-requested-strong)', borderWidth: 2 }, 'Dates needed')}
      {item({ borderColor: 'var(--mantine-color-gator-5)', borderWidth: 2 }, 'Dates confirmed')}
      <Group gap={4} wrap="nowrap">
        <IconPhoneCall size={13} color="var(--mantine-color-gator-7)" />
        <Text size="xs" c="dimmed">
          On call
        </Text>
      </Group>
    </Group>
  );
}
