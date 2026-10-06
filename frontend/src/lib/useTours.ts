import { useQueryClient } from '@tanstack/react-query';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { keys, useAction, useMe } from '../api/hooks';
import type { Me, Rota } from '../api/types';
import { leaderSteps, nextTour, USER_STEPS, type TourName } from './tours';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spotlight walkthroughs (driver.js). The first one that applies and hasn't been finished or
 * skipped starts by itself; `start` replays any of them. `setNav` forces the sidebar open while a
 * step points into it (it's collapsed on phones and can be tucked away on desktop).
 */
export function useTours(setNav: (forced: boolean) => void) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const running = useRef(false);
  const finished = useRef(new Set<TourName>());
  const finish = useAction((tour: TourName) => api<Me>(`/api/me/tours/${tour}`, { method: 'POST' }), {
    setData: (m) => [[keys.me, m]],
  });
  const markFinished = finish.mutate;

  const start = useCallback(
    async (name: TourName) => {
      const user = qc.getQueryData<Me>(keys.me);
      if (running.current || !user) return;
      running.current = true;

      let steps = USER_STEPS;
      if (name === 'leader') {
        const team = user.memberships.find((m) => m.role === 'leader');
        if (!team) {
          running.current = false;
          return;
        }
        const rotas = await qc
          .fetchQuery({
            queryKey: keys.rotas(team.team_id),
            queryFn: () => api<Rota[]>(`/api/teams/${team.team_id}/rotas`),
            staleTime: 30_000,
          })
          .catch(() => [] as Rota[]);
        steps = leaderSteps(team.team_id, rotas[0]?.id ?? null); // newest rota first
      }
      // A step without a page stays on the previous step's page, so Back lands somewhere sensible.
      let page: string | undefined;
      const routed = steps.map((s) => ({ ...s, route: (page = s.route ?? page) }));

      let navForced = false;
      const go = async (d: Driver, dir: 1 | -1) => {
        const to = routed[(d.getActiveIndex() ?? 0) + dir];
        if (to) {
          const nav = !!to.nav;
          if (nav !== navForced) {
            navForced = nav;
            setNav(nav);
            await sleep(250); // let the sidebar finish sliding before it's measured
          }
          if (to.route && to.route !== window.location.pathname) navigateRef.current(to.route);
        }
        if (dir === 1) d.moveNext();
        else d.movePrevious();
      };

      driver({
        steps: routed.map((s) => ({
          element: s.target && `[data-tour="${s.target}"]`,
          popover: { title: s.title, description: s.body, side: s.nav ? 'right' : 'bottom' },
        })),
        showProgress: true,
        progressText: '{{current}} of {{total}}',
        nextBtnText: 'Next',
        prevBtnText: 'Back',
        doneBtnText: 'Done',
        popoverClass: 'ag-tour',
        stagePadding: 6,
        waitForElement: 3000, // pages are lazy-loaded and data-driven
        disableActiveInteraction: true,
        overlayClickBehavior: 'none', // a stray click shouldn't skip the tour
        onNextClick: (_el, _step, { driver: d }) => void go(d, 1),
        onPrevClick: (_el, _step, { driver: d }) => void go(d, -1),
        onPopoverRender: (popover, { driver: d }) => {
          if (d.isLastStep()) return;
          const skip = document.createElement('button');
          skip.type = 'button';
          skip.className = 'ag-tour-skip';
          skip.textContent = 'Skip tour';
          skip.onclick = () => d.destroy();
          popover.footerButtons.prepend(skip);
        },
        onDestroyed: () => {
          running.current = false;
          finished.current.add(name);
          setNav(false);
          markFinished(name); // done and skipped both stop it auto-starting; replay is in the menu
        },
      }).drive();
    },
    [qc, setNav, markFinished],
  );

  const next = me.data ? nextTour(me.data) : null;
  useEffect(() => {
    if (!next || finished.current.has(next)) return;
    const t = setTimeout(() => void start(next), 700); // let the page paint first
    return () => clearTimeout(t);
  }, [next, start]);

  return { start };
}
