import { describe, expect, it } from 'vitest';
import type { ScheduleShift } from '../api/types';
import { dayjs } from './dates';
import { shiftDays, slotsForDays } from './swapDays';

const TZ = 'Europe/London';

function shift(id: number, start: string, end: string, rota_id = 1): ScheduleShift {
  return {
    id,
    rota_id,
    rota_name: 'R',
    team_id: 1,
    team_name: 'T',
    period_index: 0,
    user: null,
    start_at: start,
    end_at: end,
    note: '',
  };
}

const past = dayjs('2020-01-01T00:00:00Z');

describe('shiftDays', () => {
  it('splits a shift into handover-to-handover days', () => {
    const days = shiftDays([shift(1, '2026-10-05T09:00:00+01:00', '2026-10-08T09:00:00+01:00')], TZ, past);
    expect([...days.keys()]).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(days.get('2026-10-06')?.[0]).toMatchObject({
      start_at: '2026-10-06T09:00:00+01:00',
      end_at: '2026-10-07T09:00:00+01:00',
    });
  });

  it('keeps the wall-clock handover across DST and aligns partial shifts to it', () => {
    const days = shiftDays(
      [
        shift(1, '2026-10-24T09:00:00+01:00', '2026-10-26T09:00:00Z'),
        shift(2, '2026-10-28T13:00:00Z', '2026-10-29T09:00:00Z'),
      ],
      TZ,
      past,
    );
    expect(days.get('2026-10-25')?.[0].end_at).toBe('2026-10-26T09:00:00Z');
    // 13:00 Wed → 09:00 Thu belongs to Wednesday.
    expect(days.get('2026-10-28')?.[0]).toMatchObject({ shift_id: 2, end_at: '2026-10-29T09:00:00Z' });
    expect(days.has('2026-10-29')).toBe(false);
  });

  it('drops days that are over and starts the one in progress from now', () => {
    const now = dayjs('2026-10-06T12:00:00+01:00');
    const days = shiftDays([shift(1, '2026-10-05T09:00:00+01:00', '2026-10-08T09:00:00+01:00')], TZ, now);
    expect([...days.keys()]).toEqual(['2026-10-06', '2026-10-07']);
    expect(days.get('2026-10-06')?.[0].start_at).toBe('2026-10-06T12:00:00+01:00');
    expect(days.get('2026-10-07')?.[0].start_at).toBe('2026-10-07T09:00:00+01:00');
  });
});

describe('slotsForDays', () => {
  it('joins touching days and keeps separate ones apart', () => {
    const days = shiftDays([shift(1, '2026-10-05T09:00:00+01:00', '2026-10-12T09:00:00+01:00')], TZ, past);
    const slots = slotsForDays(days, ['2026-10-09', '2026-10-05', '2026-10-06']);
    expect(slots).toEqual([
      { rota_id: 1, start_at: '2026-10-05T09:00:00+01:00', end_at: '2026-10-07T09:00:00+01:00' },
      { rota_id: 1, start_at: '2026-10-09T09:00:00+01:00', end_at: '2026-10-10T09:00:00+01:00' },
    ]);
  });
});
