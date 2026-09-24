// Mirrors backend/allogator/schemas.py. Datetimes are ISO strings with the team's UTC offset;
// dates are YYYY-MM-DD strings.

export interface User {
  id: number;
  email: string;
  display_name: string;
  name: string;
  is_admin: boolean;
}

export interface MembershipBrief {
  team_id: number;
  team_name: string;
  role: 'leader' | 'member';
  on_call: boolean;
}

export interface Me extends User {
  email_notifications: boolean;
  calendar_feed_url: string;
  memberships: MembershipBrief[];
  can_create_teams: boolean;
}

export interface AppConfig {
  version: string;
  auth_mode: 'header' | 'dev';
  email_enabled: boolean;
  open_team_creation: boolean;
  base_url: string;
  logout_url: string;
}

export interface Team {
  id: number;
  name: string;
  description: string;
  timezone: string;
  default_period_days: number;
  default_num_periods: number;
  default_handover_weekday: number;
  default_handover_time: string;
  avoid_back_to_back: boolean;
  fairness_lookback_days: number;
  holiday_country: string;
  holiday_subdivision: string;
  my_role: 'leader' | 'member' | null;
  is_leader: boolean;
  member_count: number;
}

export interface Member {
  user: User;
  role: 'leader' | 'member';
  on_call: boolean;
  joined_at: string;
}

export interface TeamDetail extends Team {
  members: Member[];
}

export type RotaStatus = 'planning' | 'collecting' | 'review' | 'published';

export interface Rota {
  id: number;
  team_id: number;
  team_name: string;
  name: string;
  display_name: string;
  start_date: string;
  end_date: string;
  num_periods: number;
  period_days: number;
  handover_time: string;
  timezone: string;
  status: RotaStatus;
  availability_deadline: string | null;
  request_message: string;
  requested_at: string | null;
  generated_at: string | null;
  published_at: string | null;
  imported: boolean;
  eligible_count: number;
  submitted_count: number;
  my_submitted: boolean;
  i_am_eligible: boolean;
  open_swaps: number;
}

export interface Period {
  index: number;
  start_date: string;
  end_date: string;
  start_at: string;
  end_at: string;
  owner_id: number | null;
}

export interface Day {
  index: number;
  date: string;
  period_index: number;
  start_at: string;
  end_at: string;
  user_ids: (number | null)[];
  majority: number | null;
  locked: boolean;
  holiday: string | null;
}

export interface Shift {
  id: number;
  rota_id: number;
  period_index: number;
  user_id: number | null;
  start_at: string;
  end_at: string;
  locked: boolean;
  source: string;
  note: string;
}

export interface SolverInfo {
  status: string;
  objective: number | null;
  seconds: number;
  seed: number;
  pinned_days: number;
  kept_locked: boolean;
}

export interface RotaDetail extends Rota {
  periods: Period[];
  days: Day[];
  shifts: Shift[];
  people: User[];
  /** On-call members who haven't confirmed their dates yet. */
  unsubmitted: User[];
  shifts_visible: boolean;
  solver_info: SolverInfo | null;
}

export type AvailabilityKind = 'unavailable' | 'partial';

export interface AvailabilityEntry {
  user_id: number;
  date: string;
  kind: AvailabilityKind;
  note: string;
}

export interface AvailabilityMember {
  user: User;
  on_call: boolean;
  role: string;
  submitted_at: string | null;
  comment: string;
}

export interface AvailabilityMatrix {
  rota_id: number;
  start_date: string;
  end_date: string;
  members: AvailabilityMember[];
  entries: AvailabilityEntry[];
}

export interface Unavailability {
  date: string;
  kind: AvailabilityKind;
  note: string;
}

export interface Candidate {
  user_id: number;
  status: 'available' | 'limited' | 'some_days';
  free_days: number;
  total_days: number;
  notes: { date: string; kind: AvailabilityKind; note: string }[];
}

export interface Issue {
  id: string;
  type: 'uncovered' | 'partial_cover' | 'conflict' | 'limited' | 'back_to_back' | 'unsubmitted';
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  period_index?: number;
  start_date?: string;
  end_date?: string;
  start_at?: string;
  end_at?: string;
  user_ids?: number[];
  owner_id?: number;
  candidates?: Candidate[];
  covers?: { user_id: number; start_at: string; end_at: string; start_date: string; end_date: string }[];
  /** A leader assigned this on purpose; reported for information, not as a problem. */
  decided?: boolean;
}

export interface PersonStats {
  user_id: number;
  name: string;
  on_call: boolean;
  member: boolean;
  days: number;
  periods_owned: number;
  cover_days: number;
  conflict_days: number;
  limited_days: number;
  unavailable_days: number;
  partial_days: number;
  history_days: number;
  holiday_days: number;
  holiday_history: number;
  holiday_dates: { date: string; label: string }[];
  holiday_history_dates: { date: string; label: string }[];
  submitted: boolean;
}

export interface Analysis {
  issues: Issue[];
  stats: PersonStats[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    uncovered_days: number;
    split_periods: number;
    owners: (number | null)[];
  };
  solver: SolverInfo | null;
}

export interface ScheduleShift {
  id: number;
  rota_id: number;
  rota_name: string;
  team_id: number;
  team_name: string;
  period_index: number;
  user: User | null;
  start_at: string;
  end_at: string;
  note: string;
}

export interface TeamSchedule {
  team_id: number;
  timezone: string;
  on_call_now: ScheduleShift | null;
  shifts: ScheduleShift[];
}

export interface SwapSlot {
  rota_id: number;
  start_at: string;
  end_at: string;
}

export interface SwapOffer {
  id: number;
  offerer: User;
  rota_id: number | null;
  start_at: string | null;
  end_at: string | null;
  /** The time given back in exchange; empty for an offer to just cover it. */
  slots: SwapSlot[];
  note: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  created_at: string;
  warnings: string[];
}

export interface SwapRequest {
  id: number;
  team_id: number;
  team_name: string;
  rota_id: number;
  rota_name: string;
  requester: User;
  start_at: string;
  end_at: string;
  slots: SwapSlot[];
  note: string;
  status: 'open' | 'accepted' | 'cancelled';
  created_at: string;
  resolved_at: string | null;
  offers: SwapOffer[];
  can_offer: boolean;
  warnings: string[];
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  created_at: string;
  read_at: string | null;
}

export interface AuditEvent {
  id: number;
  action: string;
  summary: string;
  actor: User | null;
  created_at: string;
  data: Record<string, unknown> | null;
}

export interface Todo {
  dates_needed: Rota[];
  collecting: Rota[];
  my_swap_requests: SwapRequest[];
  swap_requests_to_help: SwapRequest[];
  rotas_in_progress: Rota[];
}

export interface AdminUser extends User {
  active: boolean;
  created_at: string;
  last_seen_at: string | null;
  team_count: number;
}

export interface ImportReport {
  dry_run: boolean;
  rotas: {
    name: string;
    start_date: string;
    end_date: string;
    num_periods: number;
    period_days: number;
    handover_time: string;
    timezone: string;
    shifts: number;
    overlaps: { id: number; name: string }[];
    action: 'create' | 'skip' | 'replace';
    rota_id?: number;
  }[];
  new_users: string[];
  new_members: string[];
  warnings: string[];
  summary: Record<string, number>;
}

export interface RotaDefaults {
  start_date: string;
  num_periods: number;
  period_days: number;
  handover_time: string;
}

export interface SpecialDay {
  id: number | null;
  date: string;
  label: string;
  source: 'public' | 'custom';
  team_id: number | null;
  team_name: string | null;
}

export interface HolidayCountry {
  code: string;
  name: string;
  subdivisions: { code: string; name: string }[];
}

export interface HintItem {
  tone: 'good' | 'bad' | 'neutral';
  text: string;
  kind: string;
}

export interface HintCandidate {
  user_id: number;
  name: string;
  score: number;
  availability: 'free' | 'partial' | 'unavailable';
  suggested: boolean;
  hints: HintItem[];
  why: string[];
}

export interface Hints {
  dates: string[];
  labels: Record<string, string>;
  everyone_unavailable: boolean;
  candidates: HintCandidate[];
}
