import type { Day, RotaDetail } from '../api/types';

export type AssignBody = {
  user_id: number | null;
  from_date?: string;
  to_date?: string;
  period_index?: number;
  start_at?: string;
  end_at?: string;
  lock?: boolean;
};

/** Apply an assignment to cached rota data so the board updates before the server replies. */
export function applyAssign(r: RotaDetail, b: AssignBody): RotaDetail {
  let match: ((d: Day) => boolean) | null = null;
  if (b.period_index != null) match = (d) => d.period_index === b.period_index;
  else if (b.from_date) {
    const to = b.to_date ?? b.from_date;
    match = (d) => d.date >= b.from_date! && d.date <= to;
  }
  if (!match) return r;
  const days = r.days.map((d) =>
    match!(d) ? { ...d, user_ids: [b.user_id], majority: b.user_id, locked: b.lock ?? true } : d,
  );
  const periods = r.periods.map((p) => {
    const counts = new Map<number, number>();
    for (const d of days)
      if (d.period_index === p.index && d.majority != null)
        counts.set(d.majority, (counts.get(d.majority) ?? 0) + 1);
    const owner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { ...p, owner_id: owner };
  });
  return { ...r, days, periods };
}
