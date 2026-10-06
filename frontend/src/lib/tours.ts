import type { Me } from '../api/types';

export type TourName = 'user' | 'leader';

export interface TourStep {
  /** Page to be on for this step; the tour navigates there before showing it. */
  route?: string;
  /** The target is in the sidebar, so it is forced open (it's collapsed on phones). */
  nav?: boolean;
  /** Anchor name (a `data-tour` attribute); without one the step is a centred popover. */
  target?: string;
  title: string;
  body: string;
}

export const isLeader = (me: Me) => me.memberships.some((m) => m.role === 'leader');

/** The walkthrough to start automatically: the first applicable one not yet finished or skipped. */
export function nextTour(me: Me): TourName | null {
  if (!me.tours_done.includes('user')) return 'user';
  if (isLeader(me) && !me.tours_done.includes('leader')) return 'leader';
  return null;
}

export const USER_STEPS: TourStep[] = [
  {
    title: 'Welcome to AlloGator 🐊',
    body: "A one-minute tour of where things are. You can skip it any time, and replay it later from your account menu (top right).",
  },
  {
    route: '/',
    target: 'dash-attention',
    title: 'Needs your attention',
    body: 'Date requests from your leader, swap requests you can help with and offers on your own show up here, above your upcoming shifts.',
  },
  {
    nav: true,
    target: 'nav-availability',
    title: 'My availability',
    body: "Tell your leaders which days you can't be on call. They plan the rota around it.",
  },
  {
    route: '/availability',
    target: 'avail-calendar',
    title: 'Mark the days you can’t do',
    body: 'Tap a day, or drag across several, then choose “Can’t cover” or “Partly available”. Add a note if it helps your team. It saves straight away and you can change it any time.',
  },
  {
    target: 'notifications',
    title: 'Notifications',
    body: 'Date requests, published rotas and swap offers land here (and by email, if you leave that on in your profile).',
  },
  {
    nav: true,
    target: 'nav-teams',
    title: 'Your teams',
    body: 'Open a team to see its schedule and ask a teammate to swap a shift with you on the Swaps tab.',
  },
  {
    target: 'account-menu',
    title: 'Profile and replaying this tour',
    body: 'Subscribe to your shifts in Google, Outlook or Apple Calendar from Profile & calendar. “Replay walkthrough” here brings this tour back whenever you want it.',
  },
];

/** The leader walkthrough follows a real team, and a real rota if the team has one. */
export function leaderSteps(teamId: number, rotaId: number | null): TourStep[] {
  const team = `/teams/${teamId}`;
  return [
    {
      title: 'You’re a team leader',
      body: 'Leaders plan the rota: collect everyone’s availability, generate a fair schedule, tweak it and publish. A quick look at where that happens.',
    },
    {
      route: `${team}/members`,
      target: 'team-tab-members',
      title: 'Members',
      body: 'Add people by email, choose who takes part in the on-call rotation, and make other members leaders.',
    },
    {
      route: `${team}/rotas`,
      target: 'rotas-new',
      title: 'Plan a rota',
      body: 'Each rota is one planning round. Start one here, ask the team for their dates, then generate a schedule.',
    },
    ...(rotaId
      ? [
          {
            route: `${team}/rotas/${rotaId}`,
            target: 'rota-actions',
            title: 'Move the rota along',
            body: 'The main button changes with the stage: Request dates, Generate rota, then Publish. The ⋯ menu has editing, pins and the rest.',
          },
          {
            target: 'rota-board',
            title: 'The board',
            body: 'One row per person, one column per day. Once a rota is generated, click a cell to put someone on call. Manual changes are pinned, so they survive regenerating. The Issues tab flags gaps before you publish.',
          },
        ]
      : []),
    {
      route: `${team}/swaps`,
      target: 'team-tab-swaps',
      title: 'Swaps',
      body: 'Members ask each other to cover shifts here. Leaders can manage any request, and a published rota updates when a swap is accepted.',
    },
    {
      target: 'account-menu',
      title: 'That’s the leader tour',
      body: '“Replay leader walkthrough” in this menu brings it back whenever you need it.',
    },
  ];
}
