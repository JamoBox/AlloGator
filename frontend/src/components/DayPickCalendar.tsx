import { ActionIcon, Group, SimpleGrid, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { dayjs, eachDay, ISO } from '../lib/dates';
import { HoverTip, useHoverTip } from './HoverTip';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Month calendar for picking some of a set of days: tap to toggle a day, drag across a run of
 * days, or shift-click to add everything since the last day picked. Only ``pickable`` days
 * (date -> tooltip) can be chosen; ``marked`` days (date -> tooltip) get a dashed outline.
 */
export function DayPickCalendar({
  pickable,
  selected,
  onChange,
  marked,
  months = 2,
}: {
  pickable: Map<string, string>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  marked?: Map<string, string>;
  months?: number;
}) {
  const first = [...pickable.keys()].sort()[0];
  const [month, setMonth] = useState(() => dayjs(first ?? undefined).startOf('month'));
  const drag = useRef<{ anchor: string; base: Set<string> } | null>(null);
  const lastAnchor = useRef<string | null>(null);
  const hoverTip = useHoverTip();
  const today = dayjs().format(ISO);

  const between = (a: string, b: string) => (a <= b ? eachDay(a, b) : eachDay(b, a)).filter((d) => pickable.has(d));

  const begin = (date: string, e: React.PointerEvent) => {
    if (!pickable.has(date)) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    if (e.shiftKey && lastAnchor.current) {
      onChange(new Set([...selected, ...between(lastAnchor.current, date)]));
      lastAnchor.current = date;
      return;
    }
    if (selected.has(date)) {
      const next = new Set(selected);
      next.delete(date);
      onChange(next);
      drag.current = null;
      return;
    }
    drag.current = { anchor: date, base: new Set(selected) };
    lastAnchor.current = date;
    onChange(new Set([...selected, date]));
  };

  const extend = (date: string) => {
    const d = drag.current;
    if (d) onChange(new Set([...d.base, ...between(d.anchor, date)]));
  };

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

  const monthsToShow = Array.from({ length: months }, (_, i) => month.add(i, 'month'));

  return (
    <div>
      <Group justify="space-between" mb={6}>
        <Group gap={4}>
          <ActionIcon variant="default" size="sm" onClick={() => setMonth(month.subtract(1, 'month'))} aria-label="Previous month">
            <IconChevronLeft size={14} />
          </ActionIcon>
          <ActionIcon variant="default" size="sm" onClick={() => setMonth(month.add(1, 'month'))} aria-label="Next month">
            <IconChevronRight size={14} />
          </ActionIcon>
        </Group>
        <Text size="xs" c="dimmed">
          Tap days, drag across a run, or shift-click for everything in between.
        </Text>
      </Group>
      <SimpleGrid
        cols={{ base: 1, sm: months }}
        spacing="md"
        className="ag-month"
        onPointerMove={onPointerMove}
        onMouseOver={hoverTip.onMouseOver}
        onMouseLeave={hoverTip.onMouseLeave}
        onPointerDown={hoverTip.hide}
      >
        {monthsToShow.map((m) => {
          const start = m.startOf('month');
          const lead = (start.day() + 6) % 7; // Monday-first
          const cells: (string | null)[] = [
            ...Array.from({ length: lead }, () => null),
            ...Array.from({ length: m.daysInMonth() }, (_, i) => start.add(i, 'day').format(ISO)),
          ];
          while (cells.length % 7) cells.push(null);
          return (
            <div key={m.format('YYYY-MM')}>
              <Text fw={700} size="sm" mb={4}>
                {m.format('MMMM YYYY')}
              </Text>
              <div className="ag-month-grid">
                {WEEKDAY_LABELS.map((w) => (
                  <div key={w} className="ag-weekday">
                    {w}
                  </div>
                ))}
                {cells.map((date, i) => {
                  if (!date) return <div key={`x${i}`} className="ag-day" data-outside />;
                  const d = dayjs(date);
                  const can = pickable.has(date);
                  const tip = [pickable.get(date), marked?.get(date)].filter(Boolean).join(' · ');
                  return (
                    <div
                      key={date}
                      className="ag-day"
                      data-date={date}
                      data-pickable={can || undefined}
                      data-disabled={!can || undefined}
                      data-selected={selected.has(date) || undefined}
                      data-marked={marked?.has(date) || undefined}
                      data-today={date === today || undefined}
                      data-weekend={d.day() === 0 || d.day() === 6 || undefined}
                      onPointerDown={(e) => begin(date, e)}
                      onPointerEnter={() => extend(date)}
                      role="button"
                      aria-disabled={!can}
                      aria-pressed={selected.has(date)}
                      aria-label={`${d.format('dddd D MMMM')}${tip ? `. ${tip}` : ''}`}
                      data-tip={tip || undefined}
                    >
                      <span className="ag-day-num">{d.date()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </SimpleGrid>
      <HoverTip ref={hoverTip.ref} />
    </div>
  );
}
