import { notifications } from '@mantine/notifications';
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import type {
  HolidayCountry,
  Hints,
  SpecialDay,
  AdminUser,
  Analysis,
  AppConfig,
  AuditEvent,
  AvailabilityMatrix,
  Me,
  Notification,
  Rota,
  RotaDefaults,
  RotaDetail,
  ScheduleShift,
  SwapRequest,
  Team,
  TeamDetail,
  TeamSchedule,
  Todo,
  Unavailability,
  User,
} from './types';

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  todo: ['me', 'todo'] as const,
  myShifts: ['me', 'shifts'] as const,
  myUnavailability: ['me', 'unavailability'] as const,
  teams: ['teams'] as const,
  team: (id: number) => ['teams', id] as const,
  rotas: (teamId: number) => ['teams', teamId, 'rotas'] as const,
  rotaDefaults: (teamId: number) => ['teams', teamId, 'rota-defaults'] as const,
  schedule: (teamId: number) => ['teams', teamId, 'schedule'] as const,
  swaps: (teamId: number, closed: boolean) => ['teams', teamId, 'swaps', closed] as const,
  teamAudit: (teamId: number) => ['teams', teamId, 'audit'] as const,
  rota: (id: number) => ['rotas', id] as const,
  analysis: (id: number) => ['rotas', id, 'analysis'] as const,
  availability: (id: number) => ['rotas', id, 'availability'] as const,
  rotaHistory: (id: number) => ['rotas', id, 'history'] as const,
  notifications: ['notifications'] as const,
  unread: ['notifications', 'unread'] as const,
  adminUsers: ['admin', 'users'] as const,
  devUsers: ['dev', 'users'] as const,
  mySpecialDays: ['me', 'special-days'] as const,
  specialDays: (teamId: number) => ['teams', teamId, 'special-days'] as const,
  countries: ['holiday-countries'] as const,
  hints: (rotaId: number, from: string, to: string) => ['rotas', rotaId, 'hints', from, to] as const,
};

export const useConfig = () =>
  useQuery({ queryKey: keys.config, queryFn: () => api<AppConfig>('/api/config'), staleTime: Infinity });

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/api/me') });

export const useTodo = () => useQuery({ queryKey: keys.todo, queryFn: () => api<Todo>('/api/me/todo') });

export const useMyShifts = () =>
  useQuery({ queryKey: keys.myShifts, queryFn: () => api<ScheduleShift[]>('/api/me/shifts') });

export const useMyUnavailability = () =>
  useQuery({
    queryKey: keys.myUnavailability,
    queryFn: () => api<Unavailability[]>('/api/me/unavailability'),
  });

export const useTeams = (all = false) =>
  useQuery({
    queryKey: [...keys.teams, all ? 'all' : 'mine'],
    queryFn: () => api<Team[]>(`/api/teams${all ? '?all=true' : ''}`),
  });

export const useTeam = (id: number) =>
  useQuery({ queryKey: keys.team(id), queryFn: () => api<TeamDetail>(`/api/teams/${id}`) });

export const useRotas = (teamId: number) =>
  useQuery({ queryKey: keys.rotas(teamId), queryFn: () => api<Rota[]>(`/api/teams/${teamId}/rotas`) });

export const useRotaDefaults = (teamId: number, enabled = true) =>
  useQuery({
    queryKey: keys.rotaDefaults(teamId),
    queryFn: () => api<RotaDefaults>(`/api/teams/${teamId}/rota-defaults`),
    enabled,
  });

export const useTeamSchedule = (teamId: number) =>
  useQuery({
    queryKey: keys.schedule(teamId),
    queryFn: () => api<TeamSchedule>(`/api/teams/${teamId}/schedule`),
  });

export const useSwaps = (teamId: number, includeClosed = false) =>
  useQuery({
    queryKey: keys.swaps(teamId, includeClosed),
    queryFn: () =>
      api<SwapRequest[]>(`/api/teams/${teamId}/swaps${includeClosed ? '?include_closed=true' : ''}`),
  });

export const useTeamAudit = (teamId: number, enabled = true) =>
  useQuery({
    queryKey: keys.teamAudit(teamId),
    queryFn: () => api<AuditEvent[]>(`/api/teams/${teamId}/audit`),
    enabled,
  });

export const useRota = (id: number) =>
  useQuery({ queryKey: keys.rota(id), queryFn: () => api<RotaDetail>(`/api/rotas/${id}`) });

export const useAnalysis = (id: number, enabled = true) =>
  useQuery({
    queryKey: keys.analysis(id),
    queryFn: () => api<Analysis>(`/api/rotas/${id}/analysis`),
    enabled,
  });

export const useAvailability = (id: number, enabled = true) =>
  useQuery({
    queryKey: keys.availability(id),
    queryFn: () => api<AvailabilityMatrix>(`/api/rotas/${id}/availability`),
    enabled,
  });

export const useRotaHistory = (id: number, enabled = true) =>
  useQuery({
    queryKey: keys.rotaHistory(id),
    queryFn: () => api<AuditEvent[]>(`/api/rotas/${id}/history`),
    enabled,
  });

export const useNotifications = () =>
  useQuery({
    queryKey: keys.notifications,
    queryFn: () => api<Notification[]>('/api/notifications?limit=30'),
    refetchInterval: 60_000,
  });

export const useUnreadCount = () =>
  useQuery({
    queryKey: keys.unread,
    queryFn: () => api<{ count: number }>('/api/notifications/unread-count'),
    refetchInterval: 30_000,
  });

export const useAdminUsers = (enabled = true) =>
  useQuery({
    queryKey: keys.adminUsers,
    queryFn: () => api<AdminUser[]>('/api/admin/users'),
    enabled,
  });

export const useDevUsers = (enabled: boolean) =>
  useQuery({ queryKey: keys.devUsers, queryFn: () => api<User[]>('/api/dev/users'), enabled });

export const useMySpecialDays = () =>
  useQuery({
    queryKey: keys.mySpecialDays,
    queryFn: () => api<SpecialDay[]>('/api/me/special-days'),
    staleTime: 10 * 60_000,
  });

export const useSpecialDays = (teamId: number) =>
  useQuery({
    queryKey: keys.specialDays(teamId),
    queryFn: () => api<SpecialDay[]>(`/api/teams/${teamId}/special-days`),
  });

export const useHolidayCountries = (enabled = true) =>
  useQuery({
    queryKey: keys.countries,
    queryFn: () => api<HolidayCountry[]>('/api/holidays/countries'),
    staleTime: Infinity,
    enabled,
  });

export const useHints = (rotaId: number, from: string, to: string, enabled = true) =>
  useQuery({
    queryKey: keys.hints(rotaId, from, to),
    queryFn: () => api<Hints>(`/api/rotas/${rotaId}/hints?from=${from}&to=${to}`),
    enabled,
    staleTime: 30_000,
  });

/**
 * Mutation helper: runs ``fn``, shows a toast on error (and optionally on success), and
 * invalidates the given query keys (prefix match).
 */
export function useAction<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: {
    invalidate?: QueryKey[] | ((result: TResult, args: TArgs) => QueryKey[]);
    success?: string | ((result: TResult, args: TArgs) => string | null);
    onSuccess?: (result: TResult, args: TArgs) => void;
    /** Update caches before the request; the returned function undoes it on failure. */
    optimistic?: (args: TArgs, qc: QueryClient) => (() => void) | void;
    /** Write the response straight into caches (skips a refetch round trip). */
    setData?: (result: TResult, args: TArgs) => [QueryKey, unknown][];
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (args: TArgs) => {
      if (!opts.optimistic) return undefined;
      return { rollback: opts.optimistic(args, qc) ?? undefined };
    },
    onSuccess: async (result, args) => {
      for (const [key, data] of opts.setData?.(result, args) ?? []) qc.setQueryData(key, data);
      const inv =
        typeof opts.invalidate === 'function' ? opts.invalidate(result, args) : opts.invalidate;
      // Refresh in the background: the UI already reflects the change.
      for (const k of inv ?? []) void qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === 'function' ? opts.success(result, args) : opts.success;
      if (msg) notifications.show({ message: msg, color: 'green' });
      opts.onSuccess?.(result, args);
    },
    onError: (err: Error, _args, context) => {
      context?.rollback?.();
      notifications.show({ title: 'Something went wrong', message: err.message, color: 'red' });
    },
  });
}

/** Warm the cache for a page before the user clicks through to it. */
export function usePrefetch() {
  const qc = useQueryClient();
  const opts = { staleTime: 15_000 };
  return {
    rota: (id: number, leader: boolean) => {
      void qc.prefetchQuery({ queryKey: keys.rota(id), queryFn: () => api(`/api/rotas/${id}`), ...opts });
      void qc.prefetchQuery({
        queryKey: keys.availability(id),
        queryFn: () => api(`/api/rotas/${id}/availability`),
        ...opts,
      });
      if (leader)
        void qc.prefetchQuery({
          queryKey: keys.analysis(id),
          queryFn: () => api(`/api/rotas/${id}/analysis`),
          ...opts,
        });
    },
    team: (id: number) => {
      void qc.prefetchQuery({ queryKey: keys.team(id), queryFn: () => api(`/api/teams/${id}`), ...opts });
      void qc.prefetchQuery({
        queryKey: keys.schedule(id),
        queryFn: () => api(`/api/teams/${id}/schedule`),
        ...opts,
      });
    },
  };
}
