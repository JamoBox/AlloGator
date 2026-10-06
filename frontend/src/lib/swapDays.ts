import type { ScheduleShift } from '../api/types';
import { dayjs, fmtSpan, inTz, ISO } from './dates';

export interface Slot {
  rota_id: number;
  start_at: string;
  end_at: string;
}

export interface DaySlot extends Slot {
  shift_id: number;
}

/** The most common handover time among the shifts (their usual start), e.g. "09:00". */
function handoverTime(shifts: ScheduleShift[], tz: string): string {
  const counts = new Map<string, number>();
  for (const s of shifts) {
    const t = inTz(s.start_at, tz).format('HH:mm');
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '00:00';
}

/**
 * Split shifts into on-call days, keyed by local date. A day runs handover to handover (keeping
 * the wall-clock handover time across DST changes); a shift that starts or ends mid-day only
 * contributes the part it covers. Days already over are left out, and a day in progress starts
 * from ``now``.
 */
export function shiftDays(shifts: ScheduleShift[], tz: string, now = dayjs()): Map<string, DaySlot[]> {
  const out = new Map<string, DaySlot[]>();
  if (!shifts.length) return out;
  const handover = handoverTime(shifts, tz);
  const boundary = (date: string) => dayjs.tz(`${date}T${handover}`, tz);
  for (const s of shifts) {
    const start = dayjs(s.start_at);
    const end = dayjs(s.end_at);
    let date = inTz(s.start_at, tz).format(ISO);
    if (start.isBefore(boundary(date))) date = dayjs(date).subtract(1, 'day').format(ISO);
    for (let i = 0; i < 1000; i++) {
      const next = dayjs(date).add(1, 'day').format(ISO);
      const from = boundary(date);
      const to = boundary(next);
      const a = [start, from, now].reduce((x, y) => (y.isAfter(x) ? y : x)); // time gone can't be swapped
      const b = end.isBefore(to) ? end : to;
      if (a.isBefore(b) && b.isAfter(now)) {
        const list = out.get(date) ?? [];
        list.push({ shift_id: s.id, rota_id: s.rota_id, start_at: a.tz(tz).format(), end_at: b.tz(tz).format() });
        out.set(date, list);
      }
      if (!to.isBefore(end)) break;
      date = next;
    }
  }
  return out;
}

/** The slots for the chosen days, joining touching slots of the same rota. */
export function slotsForDays(days: Map<string, DaySlot[]>, dates: Iterable<string>): Slot[] {
  const picked = [...dates]
    .flatMap((d) => days.get(d) ?? [])
    .sort((a, b) => dayjs(a.start_at).valueOf() - dayjs(b.start_at).valueOf());
  const out: Slot[] = [];
  for (const s of picked) {
    const last = out[out.length - 1];
    if (last && last.rota_id === s.rota_id && !dayjs(s.start_at).isAfter(dayjs(last.end_at))) {
      if (dayjs(s.end_at).isAfter(dayjs(last.end_at))) last.end_at = s.end_at;
    } else {
      out.push({ rota_id: s.rota_id, start_at: s.start_at, end_at: s.end_at });
    }
  }
  return out;
}

/** "Mon 5 Oct 09:00 → Wed 7 Oct 09:00; Fri 9 Oct 09:00 → Sat 10 Oct 09:00". */
export function fmtSlots(slots: { start_at: string; end_at: string }[], tz?: string) {
  return slots.map((s) => fmtSpan(s.start_at, s.end_at, tz)).join('; ');
}
