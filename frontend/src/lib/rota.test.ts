import { describe, expect, it } from 'vitest';
import type { Day, RotaDetail } from '../api/types';
import { applyAssign } from './rota';

function rota(owners: number[]): RotaDetail {
  const days: Day[] = [];
  owners.forEach((owner, p) => {
    for (let i = 0; i < 7; i++) {
      const date = `2026-10-${String(5 + p * 7 + i).padStart(2, '0')}`;
      days.push({
        index: p * 7 + i,
        date,
        period_index: p,
        start_at: `${date}T09:00:00+01:00`,
        end_at: `${date}T09:00:00+01:00`,
        user_ids: [owner],
        majority: owner,
        locked: false,
        holiday: null,
      });
    }
  });
  return {
    days,
    periods: owners.map((o, i) => ({
      index: i,
      start_date: days[i * 7].date,
      end_date: days[i * 7 + 6].date,
      start_at: '',
      end_at: '',
      owner_id: o,
    })),
  } as unknown as RotaDetail;
}

describe('applyAssign (optimistic board updates)', () => {
  it('reassigns a single day and pins it', () => {
    const r = applyAssign(rota([1, 2]), { user_id: 3, from_date: '2026-10-07' });
    const day = r.days.find((d) => d.date === '2026-10-07')!;
    expect(day.user_ids).toEqual([3]);
    expect(day.locked).toBe(true);
    expect(r.periods[0].owner_id).toBe(1);
  });

  it('reassigns a whole period and updates its owner', () => {
    const r = applyAssign(rota([1, 2]), { user_id: 3, period_index: 1, lock: false });
    expect(r.days.filter((d) => d.period_index === 1).every((d) => d.majority === 3)).toBe(true);
    expect(r.periods[1].owner_id).toBe(3);
    expect(r.days[8].locked).toBe(false);
  });

  it('can leave a range uncovered', () => {
    const r = applyAssign(rota([1]), { user_id: null, from_date: '2026-10-05', to_date: '2026-10-11' });
    expect(r.periods[0].owner_id).toBeNull();
    expect(r.days.every((d) => d.user_ids[0] === null)).toBe(true);
  });

  it('leaves custom time ranges to the server', () => {
    const before = rota([1]);
    expect(applyAssign(before, { user_id: 2, start_at: 'x', end_at: 'y' })).toBe(before);
  });
});
