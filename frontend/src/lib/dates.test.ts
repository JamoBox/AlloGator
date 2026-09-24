import { describe, expect, it } from 'vitest';
import { eachDay, fmtDateRange, fmtDateTime, groupRuns, inTz, toLocalInput } from './dates';

describe('dates', () => {
  it('keeps the wall-clock time encoded by the API when no timezone is given', () => {
    // 09:00 in London (BST) must read 09:00 regardless of the browser's timezone.
    expect(fmtDateTime('2026-10-19T09:00:00+01:00')).toBe('Mon 19 Oct 09:00');
    expect(inTz('2026-10-26T09:00:00+00:00').format('HH:mm')).toBe('09:00');
  });

  it('converts to an explicit timezone', () => {
    expect(fmtDateTime('2026-10-19T09:00:00+01:00', 'America/New_York')).toBe('Mon 19 Oct 04:00');
    expect(toLocalInput('2026-10-19T08:00:00Z', 'Europe/London')).toBe('2026-10-19T09:00');
  });

  it('enumerates and groups days', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    const runs = groupRuns(['2026-01-01', '2026-01-02', '2026-01-05'].map((date) => ({ date })));
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
  });

  it('formats ranges compactly', () => {
    expect(fmtDateRange('2026-10-19', '2026-10-25')).toBe('19 – 25 Oct 2026');
    expect(fmtDateRange('2026-10-19', '2026-12-13')).toBe('19 Oct – 13 Dec 2026');
    expect(fmtDateRange('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 – 3 Jan 2027');
  });
});
