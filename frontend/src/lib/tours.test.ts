import { describe, expect, it } from 'vitest';
import type { Me } from '../api/types';
import { leaderSteps, nextTour } from './tours';

const me = (role: 'leader' | 'member' | null, tours_done: string[] = []) =>
  ({
    tours_done,
    memberships: role ? [{ team_id: 1, team_name: 'SRE', role, on_call: true }] : [],
  }) as unknown as Me;

describe('nextTour', () => {
  it('gives everyone the user tour first, then leaders the leader tour', () => {
    expect(nextTour(me('member'))).toBe('user');
    expect(nextTour(me('leader'))).toBe('user');
    expect(nextTour(me('leader', ['user']))).toBe('leader');
    expect(nextTour(me('leader', ['user', 'leader']))).toBeNull();
  });

  it('gives a promoted member the leader tour but never nags a plain member again', () => {
    expect(nextTour(me('member', ['user']))).toBeNull();
    expect(nextTour(me('leader', ['user']))).toBe('leader'); // same user after promotion
  });
});

describe('leaderSteps', () => {
  it('only visits a rota page when the team has a rota', () => {
    const routes = (rotaId: number | null) => leaderSteps(3, rotaId).map((s) => s.route);
    expect(routes(null)).not.toContain('/teams/3/rotas/9');
    expect(routes(9)).toContain('/teams/3/rotas/9');
  });
});
