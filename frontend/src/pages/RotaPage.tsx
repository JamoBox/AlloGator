import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Menu,
  Modal,
  NumberInput,
  Select,
  Stack,
  Stepper,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Title,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconBell,
  IconCalendarDown,
  IconDots,
  IconEdit,
  IconFileTypeCsv,
  IconJson,
  IconLockOpen,
  IconMailForward,
  IconRefresh,
  IconRocket,
  IconSparkles,
  IconTrash,
  IconArrowBackUp,
} from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  keys,
  useAction,
  useAnalysis,
  useAvailability,
  useMe,
  useMyShifts,
  useRota,
  useRotaHistory,
  useTeam,
} from '../api/hooks';
import type { Analysis, Day, RotaDetail, ScheduleShift, TeamDetail } from '../api/types';
import { CalendarButton, downloadOrToast, RotaStatusBadge } from '../components/common';
import { IssuesPanel } from '../components/rota/IssuesPanel';
import { PeriodsList } from '../components/rota/PeriodsList';
import { type BoardActions, RotaBoard } from '../components/rota/RotaBoard';
import { StatsTable } from '../components/rota/StatsTable';
import { RequestSwapModal } from '../components/team/SwapsTab';
import { dayjs, fmtDateLong, fmtDateRange, fromNow, inTz, ISO, toLocalInput } from '../lib/dates';

const STEP = { planning: 0, collecting: 1, review: 2, published: 4 } as const;

export function RotaPage() {
  const params = useParams();
  const teamId = Number(params.teamId);
  const rotaId = Number(params.rotaId);
  const team = useTeam(teamId);
  const rota = useRota(rotaId);
  const me = useMe();
  const myShifts = useMyShifts();
  const leader = !!team.data?.is_leader;
  const r = rota.data;
  const analysis = useAnalysis(rotaId, !!r && (leader || r.status === 'published'));
  const matrix = useAvailability(rotaId, !!r);
  const [tab, setTab] = useState<string | null>(null);
  const [swapShift, setSwapShift] = useState<ScheduleShift | null>(null);

  if (rota.isLoading || team.isLoading) return <Loader />;
  if (!r || !team.data) return <Text c="red">{rota.error?.message ?? 'Rota not found'}</Text>;

  const hasSchedule = r.shifts_visible && r.days.some((d) => d.user_ids.some((u) => u != null));
  const defaultTab = hasSchedule ? 'board' : 'availability';
  const currentTab = tab ?? defaultTab;
  const editable = leader;

  return (
    <Stack gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to={`/teams/${teamId}`}>
          {team.data.name}
        </Anchor>
        <Anchor component={Link} to={`/teams/${teamId}/rotas`}>
          Rotas
        </Anchor>
        <Text>{r.display_name}</Text>
      </Breadcrumbs>

      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Title order={2}>{r.name || fmtDateRange(r.start_date, r.end_date)}</Title>
            <RotaStatusBadge status={r.status} />
          </Group>
          <Text c="dimmed" size="sm">
            {r.name ? `${fmtDateRange(r.start_date, r.end_date)} · ` : ''}
            {r.num_periods} periods of {r.period_days} day{r.period_days > 1 ? 's' : ''} · handover{' '}
            {r.handover_time} ({r.timezone})
          </Text>
        </div>
        {leader ? (
          <LeaderActions rota={r} team={team.data} analysis={analysis.data} />
        ) : (
          r.status === 'published' && <CalendarButton query={`?rota_id=${r.id}`} feedUrl={me.data?.calendar_feed_url} />
        )}
      </Group>

      {leader && !r.imported && <Workflow rota={r} />}
      {!leader && <MemberBanner rota={r} />}

      <Tabs value={currentTab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          {hasSchedule && <Tabs.Tab value="board">Schedule board</Tabs.Tab>}
          {hasSchedule && <Tabs.Tab value="periods">By period</Tabs.Tab>}
          {!hasSchedule && <Tabs.Tab value="availability">Availability</Tabs.Tab>}
          {analysis.data && hasSchedule && (
            <Tabs.Tab
              value="issues"
              rightSection={
                analysis.data.summary.errors + analysis.data.summary.warnings > 0 ? (
                  <Badge size="xs" circle color={analysis.data.summary.errors ? 'red' : 'orange'}>
                    {analysis.data.summary.errors + analysis.data.summary.warnings}
                  </Badge>
                ) : null
              }
            >
              Issues
            </Tabs.Tab>
          )}
          {analysis.data && <Tabs.Tab value="fairness">Fairness</Tabs.Tab>}
          <Tabs.Tab value="history">History</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="board" pt="md">
          <Stack>
            {leader && analysis.data && <IssueSummary analysis={analysis.data} onOpen={() => setTab('issues')} />}
            <Card padding="sm">
              <BoardWithActions rota={r} matrix={matrix.data} editable={editable} meId={me.data?.id} />
            </Card>
            {editable && (
              <Text size="xs" c="dimmed">
                Click a cell to put someone on call; click the “On call” row to choose who covers a
                day. Manual changes are pinned so they survive regenerating.
                {r.status === 'published' && ' Changes to a published rota notify the people affected.'}
              </Text>
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="periods" pt="md">
          <PeriodsList
            rota={r}
            meId={me.data?.id}
            myShifts={myShifts.data ?? []}
            onRequestSwap={(s) => setSwapShift(s)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="availability" pt="md">
          <Card padding="sm">
            <Text size="sm" c="dimmed" mb="xs">
              Everyone's submitted availability for this rota. Hover a cell to see notes.{' '}
              <Anchor component={Link} to={`/availability?rota=${r.id}`} size="sm">
                Update my dates →
              </Anchor>
            </Text>
            {matrix.data ? <RotaBoard rota={r} matrix={matrix.data} editable={false} highlightUserId={me.data?.id} /> : <Loader />}
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="issues" pt="md">
          {analysis.data && (
            <IssuesWithActions rota={r} analysis={analysis.data} editable={editable} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="fairness" pt="md">
          {analysis.data && (
            <Card>
              <StatsTable analysis={analysis.data} showSubmitted={r.status !== 'published'} />
              {analysis.data.solver && leader && (
                <Text size="xs" c="dimmed" mt="sm">
                  Generated in {analysis.data.solver.seconds}s (
                  {analysis.data.solver.status === 'optimal'
                    ? 'proven optimal'
                    : analysis.data.solver.status.startsWith('greedy')
                      ? 'quick fallback schedule'
                      : 'best schedule found'}
                  ){analysis.data.solver.pinned_days ? ` · ${analysis.data.solver.pinned_days} pinned day(s) kept` : ''}.
                </Text>
              )}
            </Card>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="history" pt="md">
          <History rotaId={r.id} />
        </Tabs.Panel>
      </Tabs>
      <RequestSwapModal
        team={team.data}
        opened={!!swapShift}
        onClose={() => setSwapShift(null)}
        initialShiftId={swapShift?.id}
      />
    </Stack>
  );
}

function invalidateRota(r: RotaDetail) {
  return [
    keys.rota(r.id),
    keys.analysis(r.id),
    keys.rotaHistory(r.id),
    keys.rotas(r.team_id),
    keys.schedule(r.team_id),
    keys.todo,
    keys.myShifts,
  ];
}

function Workflow({ rota }: { rota: RotaDetail }) {
  const active = STEP[rota.status];
  return (
    <Card padding="sm">
      <Stepper active={active} size="sm" allowNextStepsSelect={false}>
        <Stepper.Step label="Plan" description="Set dates & period length" />
        <Stepper.Step
          label="Collect dates"
          description={
            rota.requested_at
              ? `${rota.submitted_count}/${rota.eligible_count} confirmed`
              : 'Ask everyone for availability'
          }
        />
        <Stepper.Step label="Review" description="Generate, check & adjust" />
        <Stepper.Step label="Publish" description="Share with the team" />
      </Stepper>
    </Card>
  );
}

function MemberBanner({ rota }: { rota: RotaDetail }) {
  if (rota.status === 'published') return null;
  return (
    <Alert color="blue" icon={<IconBell />}>
      {rota.status === 'collecting' && rota.i_am_eligible ? (
        <Group justify="space-between">
          <Text size="sm">
            {rota.my_submitted
              ? "Thanks — you've confirmed your dates. You can still change them."
              : `Your leader needs your dates${rota.availability_deadline ? ` by ${fmtDateLong(rota.availability_deadline)}` : ''}.`}
          </Text>
          <Button component={Link} to={`/availability?rota=${rota.id}`} size="xs">
            {rota.my_submitted ? 'Review my dates' : 'Add my dates'}
          </Button>
        </Group>
      ) : (
        <Text size="sm">
          This rota is being prepared. You'll be notified when it's published.
        </Text>
      )}
    </Alert>
  );
}

function IssueSummary({ analysis, onOpen }: { analysis: Analysis; onOpen: () => void }) {
  const { errors, warnings, uncovered_days, split_periods } = analysis.summary;
  if (!errors && !warnings) return null;
  const parts = [
    uncovered_days ? `${uncovered_days} day(s) with no cover` : null,
    split_periods ? `${split_periods} period(s) with partial cover` : null,
    analysis.issues.some((i) => i.type === 'conflict') ? 'people scheduled when unavailable' : null,
    analysis.issues.some((i) => i.type === 'limited') ? 'people on days they are only partly available' : null,
  ].filter(Boolean);
  return (
    <Alert color={errors ? 'red' : 'orange'} icon={<IconAlertTriangle />} p="sm">
      <Group justify="space-between">
        <Text size="sm">Needs a decision: {parts.join(', ')}.</Text>
        <Button size="xs" variant="white" color={errors ? 'red' : 'orange'} onClick={onOpen}>
          Review issues
        </Button>
      </Group>
    </Alert>
  );
}

function useAssign(rota: RotaDetail) {
  return useAction(
    (body: Record<string, unknown>) => api<RotaDetail>(`/api/rotas/${rota.id}/assign`, { body: { lock: true, ...body } }),
    { invalidate: invalidateRota(rota) },
  );
}

function BoardWithActions({
  rota,
  matrix,
  editable,
  meId,
}: {
  rota: RotaDetail;
  matrix: Parameters<typeof RotaBoard>[0]['matrix'];
  editable: boolean;
  meId?: number;
}) {
  const assign = useAssign(rota);
  const lock = useAction(
    (a: { ids: number[]; locked: boolean }) =>
      api(`/api/rotas/${rota.id}/lock`, { body: { shift_ids: a.ids, locked: a.locked } }),
    { invalidate: [keys.rota(rota.id)] },
  );
  const [custom, setCustom] = useState<{ userId: number | null; day: Day } | null>(null);

  const actions: BoardActions = {
    assignDay: (userId, date) => assign.mutate({ user_id: userId, from_date: date }),
    assignPeriod: (userId, periodIndex) => assign.mutate({ user_id: userId, period_index: periodIndex }),
    customRange: (userId, day) => setCustom({ userId, day }),
    toggleLock: (day) => {
      const ids = rota.shifts
        .filter((s) => dayjs(s.start_at).isBefore(dayjs(day.end_at)) && dayjs(day.start_at).isBefore(dayjs(s.end_at)))
        .map((s) => s.id);
      lock.mutate({ ids, locked: !day.locked });
    },
  };

  return (
    <>
      <RotaBoard rota={rota} matrix={matrix} editable={editable} actions={actions} highlightUserId={meId} />
      <Modal opened={!!custom} onClose={() => setCustom(null)} title="Assign a custom time range">
        {custom && (
          <CustomRangeForm
            rota={rota}
            userId={custom.userId}
            day={custom.day}
            onSubmit={(body) => assign.mutateAsync(body).then(() => setCustom(null))}
          />
        )}
      </Modal>
    </>
  );
}

function CustomRangeForm({
  rota,
  userId,
  day,
  onSubmit,
}: {
  rota: RotaDetail;
  userId: number | null;
  day: Day;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [who, setWho] = useState<string | null>(userId == null ? 'none' : String(userId));
  const [start, setStart] = useState(toLocalInput(day.start_at, rota.timezone));
  const [end, setEnd] = useState(toLocalInput(day.end_at, rota.timezone));
  const [busy, setBusy] = useState(false);
  return (
    <Stack>
      <Select
        label="Who"
        data={[
          ...rota.people.map((p) => ({ value: String(p.id), label: p.name })),
          { value: 'none', label: 'Nobody (leave uncovered)' },
        ]}
        value={who}
        onChange={setWho}
        allowDeselect={false}
      />
      <Group grow>
        <TextInput type="datetime-local" label={`From (${rota.timezone})`} value={start} onChange={(e) => setStart(e.currentTarget.value)} />
        <TextInput type="datetime-local" label="To" value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
      </Group>
      <Text size="xs" c="dimmed">
        Use this for partial cover, e.g. someone else covering 13:00–17:00.
      </Text>
      <Group justify="flex-end">
        <Button
          loading={busy}
          disabled={!start || !end || end <= start}
          onClick={() => {
            setBusy(true);
            onSubmit({ user_id: who === 'none' ? null : Number(who), start_at: start, end_at: end }).finally(() =>
              setBusy(false),
            );
          }}
        >
          Assign
        </Button>
      </Group>
    </Stack>
  );
}

function IssuesWithActions({ rota, analysis, editable }: { rota: RotaDetail; analysis: Analysis; editable: boolean }) {
  const assign = useAssign(rota);
  const remind = useAction(() => api<{ reminded: number }>(`/api/rotas/${rota.id}/remind`, { method: 'POST' }), {
    success: (r) => `Reminder sent to ${r.reminded} people`,
  });
  return (
    <IssuesPanel
      analysis={analysis}
      people={rota.people}
      editable={editable}
      actions={{
        assignDates: (userId, from, to) => assign.mutate({ user_id: userId, from_date: from, to_date: to }),
        assignPeriod: (userId, periodIndex) => assign.mutate({ user_id: userId, period_index: periodIndex }),
        remind: () => remind.mutate(undefined),
      }}
    />
  );
}

function History({ rotaId }: { rotaId: number }) {
  const history = useRotaHistory(rotaId);
  if (history.isLoading) return <Loader />;
  if (!history.data?.length) return <Text c="dimmed">No history yet.</Text>;
  return (
    <Card>
      <Timeline bulletSize={14} lineWidth={2}>
        {history.data.map((e) => (
          <Timeline.Item key={e.id} title={e.summary}>
            <Text size="xs" c="dimmed">
              {e.actor?.name ?? 'System'} · {inTz(e.created_at).format('ddd D MMM YYYY HH:mm')} ({fromNow(e.created_at)})
            </Text>
          </Timeline.Item>
        ))}
      </Timeline>
    </Card>
  );
}

// --- Leader actions ---------------------------------------------------------------------------

function LeaderActions({
  rota,
  team,
  analysis,
}: {
  rota: RotaDetail;
  team: TeamDetail;
  analysis?: Analysis;
}) {
  const navigate = useNavigate();
  const inv = invalidateRota(rota);
  const [requestOpen, requestModal] = useDisclosure(false);
  const [generateOpen, generateModal] = useDisclosure(false);
  const [editOpen, editModal] = useDisclosure(false);
  const hasSchedule = rota.days.some((d) => d.user_ids.some((u) => u != null));
  const lockedDays = rota.days.filter((d) => d.locked).length;

  const remind = useAction(() => api<{ reminded: number }>(`/api/rotas/${rota.id}/remind`, { method: 'POST' }), {
    success: (r) => `Reminder sent to ${r.reminded} people`,
    invalidate: inv,
  });
  const publish = useAction(() => api(`/api/rotas/${rota.id}/publish`, { method: 'POST' }), {
    invalidate: inv,
    success: 'Published! Everyone has been notified.',
  });
  const unpublish = useAction(() => api(`/api/rotas/${rota.id}/unpublish`, { method: 'POST' }), {
    invalidate: inv,
    success: 'Rota moved back to draft',
  });
  const unlockAll = useAction(() => api(`/api/rotas/${rota.id}/lock`, { body: { locked: false } }), {
    invalidate: inv,
    success: 'All pins removed',
  });
  const del = useAction(() => api(`/api/rotas/${rota.id}`, { method: 'DELETE' }), {
    invalidate: [keys.rotas(team.id), keys.todo],
    onSuccess: () => navigate(`/teams/${team.id}/rotas`),
  });

  const confirmPublish = () =>
    modals.openConfirmModal({
      title: 'Publish this rota?',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Everyone in {team.name} will be notified and can download their shifts as calendar
            events. You can still make changes afterwards (people affected are notified).
          </Text>
          {analysis && analysis.summary.errors > 0 && (
            <Alert color="red" p="xs" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">
                There {analysis.summary.errors === 1 ? 'is' : 'are'} still {analysis.summary.errors}{' '}
                unresolved problem{analysis.summary.errors > 1 ? 's' : ''} (e.g. days with no cover).
              </Text>
            </Alert>
          )}
        </Stack>
      ),
      labels: { confirm: 'Publish', cancel: 'Cancel' },
      onConfirm: () => publish.mutate(undefined),
    });

  const primary = (() => {
    switch (rota.status) {
      case 'planning':
        return (
          <Button leftSection={<IconMailForward size={16} />} onClick={requestModal.open}>
            Request dates
          </Button>
        );
      case 'collecting':
        return (
          <>
            <Button variant="default" leftSection={<IconBell size={16} />} onClick={() => remind.mutate(undefined)} loading={remind.isPending}>
              Remind ({rota.eligible_count - rota.submitted_count})
            </Button>
            <Button leftSection={<IconSparkles size={16} />} onClick={generateModal.open}>
              Generate rota
            </Button>
          </>
        );
      case 'review':
        return (
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={generateModal.open}>
              {hasSchedule ? 'Regenerate' : 'Generate'}
            </Button>
            <Button leftSection={<IconRocket size={16} />} onClick={confirmPublish} disabled={!hasSchedule} loading={publish.isPending}>
              Publish
            </Button>
          </>
        );
      case 'published':
        return (
          <Button
            variant="default"
            leftSection={<IconArrowBackUp size={16} />}
            onClick={() =>
              modals.openConfirmModal({
                title: 'Take this rota back to draft?',
                children: (
                  <Text size="sm">
                    Members will be told it's being revised, open swap requests are cancelled, and
                    you'll be able to regenerate it. Publish again when you're done.
                  </Text>
                ),
                labels: { confirm: 'Unpublish', cancel: 'Cancel' },
                onConfirm: () => unpublish.mutate(undefined),
              })
            }
          >
            Unpublish to revise
          </Button>
        );
    }
  })();

  return (
    <Group gap="xs">
      {primary}
      <Menu position="bottom-end" withArrow>
        <Menu.Target>
          <Button variant="default" px="xs" aria-label="More actions">
            <IconDots size={18} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {rota.status !== 'published' && (
            <Menu.Item leftSection={<IconEdit size={16} />} onClick={editModal.open}>
              Edit dates & settings
            </Menu.Item>
          )}
          {rota.status === 'planning' && (
            <Menu.Item leftSection={<IconSparkles size={16} />} onClick={generateModal.open}>
              Generate without asking for dates
            </Menu.Item>
          )}
          {(rota.status === 'collecting' || rota.status === 'review') && (
            <Menu.Item leftSection={<IconMailForward size={16} />} onClick={requestModal.open}>
              {rota.requested_at ? 'Re-send date request' : 'Request dates'}
            </Menu.Item>
          )}
          {lockedDays > 0 && (
            <Menu.Item leftSection={<IconLockOpen size={16} />} onClick={() => unlockAll.mutate(undefined)}>
              Unpin all ({lockedDays} days)
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Label>Export this rota</Menu.Label>
          <Menu.Item
            leftSection={<IconJson size={16} />}
            onClick={() => downloadOrToast(`/api/teams/${team.id}/export?format=json&rota_id=${rota.id}`, 'rota.json')}
          >
            JSON
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileTypeCsv size={16} />}
            onClick={() => downloadOrToast(`/api/teams/${team.id}/export?format=csv&rota_id=${rota.id}`, 'rota.csv')}
          >
            CSV
          </Menu.Item>
          <Menu.Item
            leftSection={<IconCalendarDown size={16} />}
            onClick={() => downloadOrToast(`/api/teams/${team.id}/export?format=ics&rota_id=${rota.id}`, 'rota.ics')}
          >
            Calendar (.ics, everyone)
          </Menu.Item>
          <Menu.Item
            leftSection={<IconCalendarDown size={16} />}
            onClick={() => downloadOrToast(`/api/me/calendar.ics?rota_id=${rota.id}`, 'my-on-call.ics')}
          >
            My shifts (.ics)
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={() =>
              modals.openConfirmModal({
                title: 'Delete this rota?',
                children: <Text size="sm">This deletes the rota, its schedule and swap history.</Text>,
                labels: { confirm: 'Delete', cancel: 'Cancel' },
                confirmProps: { color: 'red' },
                onConfirm: () => del.mutate(undefined),
              })
            }
          >
            Delete rota
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={requestOpen} onClose={requestModal.close} title="Request dates from the team">
        {requestOpen && <RequestDatesForm rota={rota} onDone={requestModal.close} />}
      </Modal>
      <Modal opened={generateOpen} onClose={generateModal.close} title={hasSchedule ? 'Regenerate the rota' : 'Generate the rota'}>
        {generateOpen && (
          <GenerateForm rota={rota} lockedDays={lockedDays} hasSchedule={hasSchedule} onDone={generateModal.close} />
        )}
      </Modal>
      <Modal opened={editOpen} onClose={editModal.close} title="Edit rota">
        {editOpen && <EditRotaForm rota={rota} hasSchedule={hasSchedule} onDone={editModal.close} />}
      </Modal>
    </Group>
  );
}

function RequestDatesForm({ rota, onDone }: { rota: RotaDetail; onDone: () => void }) {
  const [deadline, setDeadline] = useState<string | null>(
    rota.availability_deadline ?? dayjs().add(7, 'day').format(ISO),
  );
  const [message, setMessage] = useState(rota.request_message);
  const send = useAction(
    () => api(`/api/rotas/${rota.id}/request-dates`, { body: { deadline, message } }),
    {
      invalidate: invalidateRota(rota),
      success: `Request sent to ${rota.eligible_count} people`,
      onSuccess: onDone,
    },
  );
  return (
    <Stack>
      <Text size="sm">
        Everyone on the rota ({rota.eligible_count} people) gets an email and an in-app notification
        asking them to mark the days they can't cover between {fmtDateRange(rota.start_date, rota.end_date)}.
      </Text>
      <DateInput label="Deadline" value={deadline} onChange={setDeadline} valueFormat="ddd D MMM YYYY" clearable />
      <Textarea
        label="Message (optional)"
        placeholder="e.g. Please include conference travel and holidays"
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        autosize
        minRows={2}
      />
      <Group justify="flex-end">
        <Button leftSection={<IconMailForward size={16} />} onClick={() => send.mutate(undefined)} loading={send.isPending}>
          Send request
        </Button>
      </Group>
    </Stack>
  );
}

function GenerateForm({
  rota,
  lockedDays,
  hasSchedule,
  onDone,
}: {
  rota: RotaDetail;
  lockedDays: number;
  hasSchedule: boolean;
  onDone: () => void;
}) {
  const [keepLocked, setKeepLocked] = useState(true);
  const missing = rota.eligible_count - rota.submitted_count;
  const gen = useAction(
    () => api(`/api/rotas/${rota.id}/generate`, { body: { keep_locked: keepLocked } }),
    {
      invalidate: invalidateRota(rota),
      success: hasSchedule ? 'New rota generated' : 'Rota generated — review it before publishing',
      onSuccess: onDone,
    },
  );
  return (
    <Stack>
      <Text size="sm">
        AlloGator finds the fairest schedule it can: everyone covered where possible, whole periods
        per person (partial cover only when nobody can do a full period), nobody on days they can't
        do, recent on-call load balanced, and no back-to-back periods where avoidable.
      </Text>
      {hasSchedule && (
        <Text size="sm">Regenerating may produce a different, equally fair arrangement.</Text>
      )}
      {missing > 0 && rota.requested_at && (
        <Alert color="orange" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">
            {missing} {missing === 1 ? 'person hasn’t' : 'people haven’t'} confirmed their dates
            yet. You can generate anyway and regenerate later.
          </Text>
        </Alert>
      )}
      {lockedDays > 0 && (
        <Checkbox
          label={`Keep my ${lockedDays} pinned day(s) as they are`}
          checked={keepLocked}
          onChange={(e) => setKeepLocked(e.currentTarget.checked)}
        />
      )}
      <Group justify="flex-end">
        <Button leftSection={<IconSparkles size={16} />} onClick={() => gen.mutate(undefined)} loading={gen.isPending}>
          {gen.isPending ? 'Thinking…' : hasSchedule ? 'Regenerate' : 'Generate'}
        </Button>
      </Group>
    </Stack>
  );
}

function EditRotaForm({ rota, hasSchedule, onDone }: { rota: RotaDetail; hasSchedule: boolean; onDone: () => void }) {
  const [name, setName] = useState(rota.name);
  const [start, setStart] = useState<string | null>(rota.start_date);
  const [periods, setPeriods] = useState(rota.num_periods);
  const [periodDays, setPeriodDays] = useState(rota.period_days);
  const [handover, setHandover] = useState(rota.handover_time);
  const [deadline, setDeadline] = useState<string | null>(rota.availability_deadline);
  const gridChanged =
    start !== rota.start_date ||
    periods !== rota.num_periods ||
    periodDays !== rota.period_days ||
    handover !== rota.handover_time;
  const save = useAction(
    () =>
      api(`/api/rotas/${rota.id}`, {
        method: 'PATCH',
        body: {
          name,
          start_date: start,
          num_periods: periods,
          period_days: periodDays,
          handover_time: handover,
          availability_deadline: deadline,
        },
      }),
    { invalidate: invalidateRota(rota), success: 'Rota updated', onSuccess: onDone },
  );
  return (
    <Stack>
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <DateInput label="First day" value={start} onChange={setStart} valueFormat="ddd D MMM YYYY" />
      <Group grow>
        <NumberInput label="Periods" min={1} max={104} value={periods} onChange={(v) => setPeriods(Number(v) || 1)} />
        <NumberInput label="Days per period" min={1} max={90} value={periodDays} onChange={(v) => setPeriodDays(Number(v) || 1)} />
      </Group>
      <TextInput label="Handover time" type="time" value={handover} onChange={(e) => setHandover(e.currentTarget.value)} />
      <DateInput label="Availability deadline" value={deadline} onChange={setDeadline} valueFormat="ddd D MMM YYYY" clearable />
      {gridChanged && hasSchedule && (
        <Alert color="orange" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">Changing the dates clears the generated schedule.</Text>
        </Alert>
      )}
      <Group justify="flex-end">
        <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
          Save
        </Button>
      </Group>
    </Stack>
  );
}
