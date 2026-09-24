import dayjs, { type Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.extend(isoWeek);

export { dayjs };

export const ISO = 'YYYY-MM-DD';

/**
 * An ISO datetime as wall-clock time. With ``tz`` it is converted to that timezone; without,
 * the wall-clock time encoded in the string is kept (the API returns times in the team's
 * timezone, so on-call handovers read the same for everyone, wherever they are).
 */
export function inTz(value: string, tz?: string): Dayjs {
  if (tz) return dayjs(value).tz(tz);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/.exec(value);
  return m ? dayjs(m[1]) : dayjs(value);
}

export function fmtDateTime(value: string, tz?: string) {
  return inTz(value, tz).format('ddd D MMM HH:mm');
}

export function fmtDate(value: string) {
  return dayjs(value).format('ddd D MMM');
}

export function fmtDateLong(value: string) {
  return dayjs(value).format('ddd D MMM YYYY');
}

export function fmtDateRange(a: string, b: string) {
  const da = dayjs(a);
  const db = dayjs(b);
  if (da.isSame(db, 'day')) return da.format('ddd D MMM YYYY');
  if (da.year() !== db.year()) return `${da.format('D MMM YYYY')} – ${db.format('D MMM YYYY')}`;
  if (da.month() === db.month()) return `${da.format('D')} – ${db.format('D MMM YYYY')}`;
  return `${da.format('D MMM')} – ${db.format('D MMM YYYY')}`;
}

/** Range of shift times, e.g. "Mon 5 Oct 09:00 → Mon 12 Oct 09:00". */
export function fmtSpan(start: string, end: string, tz?: string) {
  return `${fmtDateTime(start, tz)} → ${fmtDateTime(end, tz)}`;
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  let d = dayjs(start);
  const last = dayjs(end);
  while (!d.isAfter(last, 'day')) {
    out.push(d.format(ISO));
    d = d.add(1, 'day');
  }
  return out;
}

export function fromNow(value: string) {
  return dayjs(value).fromNow();
}

/** Group sorted ISO dates into contiguous [first, last] runs. */
export function groupRuns<T extends { date: string }>(items: T[]): T[][] {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const runs: T[][] = [];
  for (const item of sorted) {
    const last = runs[runs.length - 1];
    if (last && dayjs(last[last.length - 1].date).add(1, 'day').format(ISO) === item.date) {
      last.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

/** A value for <input type="datetime-local"> from an ISO string, in ``tz``. */
export function toLocalInput(value: string, tz?: string) {
  return inTz(value, tz).format('YYYY-MM-DDTHH:mm');
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
