import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Radio,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconAlertTriangle, IconArrowsExchange, IconPlus } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { keys, useAction, useMe, useMyShifts, useMyUnavailability, useSwaps } from '../../api/hooks';
import type { ScheduleShift, SwapRequest, TeamDetail } from '../../api/types';
import { eachDay, fmtDate, fmtDateRange, fmtSpan, fromNow, groupRuns, inTz, ISO, toLocalInput } from '../../lib/dates';
import { fmtSlots, type Slot, shiftDays, slotsForDays } from '../../lib/swapDays';
import { PersonChip } from '../common';
import { DayPickCalendar } from '../DayPickCalendar';

export function SwapsTab({ team }: { team: TeamDetail }) {
  const [showClosed, setShowClosed] = useState(false);
  const swaps = useSwaps(team.id, showClosed);
  const myShifts = useMyShifts();
  const [params] = useSearchParams();
  const focus = Number(params.get('request')) || null;
  const [opened, modal] = useDisclosure(false);
  const teamShifts = (myShifts.data ?? []).filter((s) => s.team_id === team.id);

  useEffect(() => {
    if (focus && swaps.data) {
      document.getElementById(`swap-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focus, swaps.data]);

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed" maw={640}>
          Can't make one of your shifts? Ask for a swap. Everyone on the rota is notified and can
          offer one of their own slots in exchange (or just offer to cover). Once you accept an
          offer the published rota and everyone's calendars update.
        </Text>
        <Group>
          <Switch label="Show closed" checked={showClosed} onChange={(e) => setShowClosed(e.currentTarget.checked)} />
          <Button leftSection={<IconPlus size={16} />} onClick={modal.open} disabled={teamShifts.length === 0}>
            Request a swap
          </Button>
        </Group>
      </Group>
      {swaps.isLoading && <Loader />}
      {swaps.data?.length === 0 && (
        <Card>
          <Text c="dimmed" ta="center">
            No {showClosed ? '' : 'open '}swap requests.
          </Text>
        </Card>
      )}
      {swaps.data?.map((s) => (
        <SwapCard key={s.id} swap={s} team={team} highlighted={s.id === focus} myShifts={teamShifts} />
      ))}
      <Modal opened={opened} onClose={modal.close} title="Request a swap" size="lg">
        {opened && <RequestSwapForm team={team} shifts={teamShifts} onDone={modal.close} />}
      </Modal>
    </Stack>
  );
}

/**
 * Pick some of your on-call days from a calendar (separate days or runs of days), or exact
 * times for part of a day.
 */
export function SlotPicker({
  shifts,
  tz,
  onChange,
  initialShiftId,
  initialDate,
  marked,
  warn,
  mine,
}: {
  shifts: ScheduleShift[];
  tz: string;
  onChange: (slots: Slot[]) => void;
  initialShiftId?: number;
  initialDate?: string;
  marked?: Map<string, string>;
  warn?: Map<string, { kind: 'unavailable' | 'partial'; tip: string }>;
  mine?: Map<string, { kind: 'unavailable' | 'partial'; tip: string }>;
}) {
  const days = useMemo(() => shiftDays(shifts, tz), [shifts, tz]);
  const pickable = useMemo(
    () =>
      new Map(
        [...days].map(([date, slots]) => [
          date,
          `You're on call ${slots.map((s) => `${inTz(s.start_at, tz).format('ddd HH:mm')} → ${inTz(s.end_at, tz).format('ddd HH:mm')}`).join(', ')}`,
        ]),
      ),
    [days, tz],
  );
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialDate && days.has(initialDate)) return new Set([initialDate]);
    if (initialShiftId)
      return new Set([...days].filter(([, slots]) => slots.some((s) => s.shift_id === initialShiftId)).map(([d]) => d));
    return new Set();
  });
  const picked = useMemo(() => slotsForDays(days, selected), [days, selected]);

  const [custom, setCustom] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  useEffect(() => {
    if (picked.length) {
      setCustomStart(toLocalInput(picked[0].start_at, tz));
      setCustomEnd(toLocalInput(picked[picked.length - 1].end_at, tz));
    }
  }, [picked, tz]);

  useEffect(() => {
    if (!custom) return onChange(picked);
    if (!picked.length || !customStart || !customEnd || customEnd <= customStart) return onChange([]);
    onChange([{ rota_id: picked[0].rota_id, start_at: customStart, end_at: customEnd }]);
  }, [picked, custom, customStart, customEnd]);

  if (days.size === 0) {
    return <Text c="dimmed">You have no upcoming on-call days in this team.</Text>;
  }
  const runs = groupRuns([...selected].map((date) => ({ date })));
  return (
    <Stack gap="sm">
      <DayPickCalendar pickable={pickable} selected={selected} onChange={setSelected} marked={marked} warn={warn} mine={mine} />
      <Group justify="space-between" gap="xs">
        <Text size="sm" fw={600}>
          {selected.size === 0
            ? 'Pick the days from your on-call time (green)'
            : `${selected.size} day${selected.size > 1 ? 's' : ''}: ${runs
                .map((r) => fmtDateRange(r[0].date, r[r.length - 1].date))
                .join(', ')}`}
        </Text>
        {selected.size > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        )}
      </Group>
      {picked.length > 0 && !custom && (
        <Text size="xs" c="dimmed">
          {fmtSlots(picked, tz)}
        </Text>
      )}
      {picked.length === 1 && (
        <Checkbox
          label="Only part of this time — set exact times"
          checked={custom}
          onChange={(e) => setCustom(e.currentTarget.checked)}
        />
      )}
      {custom && picked.length === 1 && (
        <Group grow>
          <TextInput type="datetime-local" label={`Start (${tz})`} value={customStart} onChange={(e) => setCustomStart(e.currentTarget.value)} />
          <TextInput type="datetime-local" label={`End (${tz})`} value={customEnd} onChange={(e) => setCustomEnd(e.currentTarget.value)} />
        </Group>
      )}
    </Stack>
  );
}

function RequestSwapForm({
  team,
  shifts,
  onDone,
  initialShiftId,
  initialDate,
}: {
  team: TeamDetail;
  shifts: ScheduleShift[];
  onDone: () => void;
  initialShiftId?: number;
  initialDate?: string;
}) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [note, setNote] = useState('');
  const create = useAction(() => api<SwapRequest>('/api/swaps', { body: { slots, note } }), {
    invalidate: [keys.swaps(team.id, false), keys.swaps(team.id, true), keys.todo],
    success: 'Swap request sent to your team',
    onSuccess: onDone,
  });
  return (
    <Stack>
      <SlotPicker
        shifts={shifts}
        tz={team.timezone}
        onChange={setSlots}
        initialShiftId={initialShiftId}
        initialDate={initialDate}
      />
      <Textarea
        label="Note"
        placeholder="Why, and anything that would help, e.g. “Happy to take any weekend in exchange”"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button onClick={() => create.mutate(undefined)} disabled={!slots.length} loading={create.isPending}>
          Ask the team
        </Button>
      </Group>
    </Stack>
  );
}

export function RequestSwapModal({
  team,
  opened,
  onClose,
  initialShiftId,
  initialDate,
}: {
  team: TeamDetail;
  opened: boolean;
  onClose: () => void;
  initialShiftId?: number;
  initialDate?: string;
}) {
  const shifts = useMyShifts();
  const teamShifts = (shifts.data ?? []).filter((s) => s.team_id === team.id);
  return (
    <Modal opened={opened} onClose={onClose} title="Request a swap" size="lg">
      {opened && (
        <RequestSwapForm
          team={team}
          shifts={teamShifts}
          onDone={onClose}
          initialShiftId={initialShiftId}
          initialDate={initialDate}
        />
      )}
    </Modal>
  );
}

const STATUS_COLOR: Record<string, string> = {
  open: 'grape',
  accepted: 'gator',
  cancelled: 'gray',
  pending: 'blue',
  declined: 'gray',
  withdrawn: 'gray',
};

function SwapCard({
  swap,
  team,
  highlighted,
  myShifts,
}: {
  swap: SwapRequest;
  team: TeamDetail;
  highlighted: boolean;
  myShifts: ScheduleShift[];
}) {
  const me = useMe();
  const qc = useQueryClient();
  const [offerOpen, offerModal] = useDisclosure(false);
  const isRequester = me.data?.id === swap.requester.id;
  const canManage = isRequester || team.is_leader;
  const tz = team.timezone;
  const inv = [keys.swaps(team.id, false), keys.swaps(team.id, true), keys.todo, keys.myShifts, keys.schedule(team.id), keys.rota(swap.rota_id)];

  const act = useAction(
    (a: { path: string; msg: string }) => api<SwapRequest>(`/api/swaps/${swap.id}${a.path}`, { method: 'POST' }),
    {
      // Show the updated request straight away (e.g. a withdrawn offer disappears).
      setData: (res) =>
        [false, true].map((closed) => [
          keys.swaps(team.id, closed),
          qc
            .getQueryData<SwapRequest[]>(keys.swaps(team.id, closed))
            ?.flatMap((x) => (x.id !== res.id ? [x] : closed || res.status === 'open' ? [res] : [])),
        ]),
      invalidate: inv,
      success: (_, a) => a.msg,
    },
  );

  const accept = (offerId: number, name: string) =>
    modals.openConfirmModal({
      title: 'Accept this swap?',
      children: (
        <Text size="sm">
          The published rota will be updated straight away and {name} will be notified. Remember to
          refresh your calendar (or use the subscription link).
        </Text>
      ),
      labels: { confirm: 'Accept swap', cancel: 'Not yet' },
      onConfirm: () => act.mutate({ path: `/offers/${offerId}/accept`, msg: 'Swap agreed — the rota has been updated' }),
    });

  const pendingOffers = swap.offers.filter((o) => o.status === 'pending');
  return (
    <Card
      id={`swap-${swap.id}`}
      style={highlighted ? { borderColor: 'var(--mantine-color-grape-5)', borderWidth: 2 } : undefined}
    >
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Group gap="xs">
            <PersonChip user={swap.requester} size="md" />
            <Text size="sm" c="dimmed">
              needs cover
            </Text>
            <Badge color={STATUS_COLOR[swap.status]} variant="light">
              {swap.status}
            </Badge>
          </Group>
          <Stack gap={0}>
            {swap.slots.map((sl) => (
              <Text key={sl.start_at} fw={600}>
                {fmtSpan(sl.start_at, sl.end_at, tz)}
              </Text>
            ))}
          </Stack>
          {swap.note && (
            <Text size="sm" fs="italic">
              “{swap.note}”
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Requested {fromNow(swap.created_at)}
          </Text>
        </Stack>
        <Group gap="xs">
          {swap.can_offer && (
            <Button leftSection={<IconArrowsExchange size={16} />} onClick={offerModal.open}>
              I can help
            </Button>
          )}
          {swap.status === 'open' && canManage && (
            <Button
              variant="subtle"
              color="gray"
              onClick={() => act.mutate({ path: '/cancel', msg: 'Swap request cancelled' })}
            >
              Cancel request
            </Button>
          )}
        </Group>
      </Group>
      {swap.warnings.map((w) => (
        <Alert key={w} color="orange" mt="xs" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text size="xs">{w}</Text>
        </Alert>
      ))}
      {swap.offers.length > 0 && (
        <Stack gap="xs" mt="md">
          <Text size="sm" fw={600}>
            Offers ({pendingOffers.length} pending)
          </Text>
          {swap.offers.map((o) => (
            <Card key={o.id} withBorder p="sm" bg="var(--mantine-color-default-hover)">
              <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                  <Group gap="xs">
                    <PersonChip user={o.offerer} />
                    <Badge size="xs" color={STATUS_COLOR[o.status]} variant="light">
                      {o.status}
                    </Badge>
                  </Group>
                  <Text size="sm">
                    {o.slots.length ? (
                      <>
                        Takes your slot and gives you <b>{fmtSlots(o.slots, tz)}</b>
                      </>
                    ) : (
                      <>Will cover it (no swap back needed)</>
                    )}
                  </Text>
                  {o.note && (
                    <Text size="xs" fs="italic">
                      “{o.note}”
                    </Text>
                  )}
                  {o.warnings.map((w) => (
                    <Text key={w} size="xs" c="orange">
                      ⚠ {w}
                    </Text>
                  ))}
                </Stack>
                {o.status === 'pending' && swap.status === 'open' && (
                  <Group gap="xs">
                    {canManage && (
                      <>
                        <Button size="xs" onClick={() => accept(o.id, o.offerer.name)}>
                          Accept
                        </Button>
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => act.mutate({ path: `/offers/${o.id}/decline`, msg: 'Offer declined' })}
                        >
                          Decline
                        </Button>
                      </>
                    )}
                    {o.offerer.id === me.data?.id && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => act.mutate({ path: `/offers/${o.id}/withdraw`, msg: 'Offer withdrawn' })}
                      >
                        Withdraw
                      </Button>
                    )}
                  </Group>
                )}
              </Group>
            </Card>
          ))}
        </Stack>
      )}
      <Modal opened={offerOpen} onClose={offerModal.close} title="Offer to help" size="lg">
        {offerOpen && <OfferForm swap={swap} team={team} myShifts={myShifts} onDone={offerModal.close} />}
      </Modal>
    </Card>
  );
}

function OfferForm({
  swap,
  team,
  myShifts,
  onDone,
}: {
  swap: SwapRequest;
  team: TeamDetail;
  myShifts: ScheduleShift[];
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'cover' | 'swap'>(myShifts.length ? 'swap' : 'cover');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [note, setNote] = useState('');
  // Show the days they need covered on the calendar for reference.
  const requested = useMemo(() => {
    const m = new Map<string, string>();
    for (const sl of swap.slots)
      for (const d of eachDay(inTz(sl.start_at, team.timezone).format(ISO), inTz(sl.end_at, team.timezone).subtract(1, 'minute').format(ISO)))
        m.set(d, `${swap.requester.name} needs cover`);
    return m;
  }, [swap, team.timezone]);
  // Days they've said they can't do, so you don't offer those in exchange.
  const first = swap.requester.name.split(' ')[0];
  const cant = useMemo(
    () =>
      new Map(
        swap.requester_unavailable.map((e) => [
          e.date,
          {
            kind: e.kind,
            tip: `${first} ${e.kind === 'unavailable' ? "can't do this day" : 'is only partly available'}${e.note ? `: ${e.note}` : ''}`,
          },
        ]),
      ),
    [swap, first],
  );
  // Days you've said you can't do yourself.
  const myUnavailability = useMyUnavailability();
  const mine = useMemo(
    () =>
      new Map(
        (myUnavailability.data ?? []).map((e) => [
          e.date,
          {
            kind: e.kind,
            tip: `You said you ${e.kind === 'unavailable' ? "can't do this day" : 'are only partly available'}${e.note ? `: ${e.note}` : ''}`,
          },
        ]),
      ),
    [myUnavailability.data],
  );
  const clashes = [...requested.keys()].filter((d) => mine.has(d)).sort();
  const offer = useAction(
    () =>
      api<SwapRequest>(`/api/swaps/${swap.id}/offers`, {
        body: mode === 'swap' ? { slots, note } : { note },
      }),
    {
      invalidate: [keys.swaps(team.id, false), keys.swaps(team.id, true), keys.todo],
      success: `Offer sent to ${swap.requester.name}`,
      onSuccess: onDone,
    },
  );
  return (
    <Stack>
      <Text size="sm">
        {swap.requester.name} needs cover for <b>{fmtSlots(swap.slots, team.timezone)}</b>.
      </Text>
      {clashes.length > 0 && (
        <Alert color="red" p="xs" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">
            You've marked {clashes.map((d) => `${fmtDate(d)} (${mine.get(d)!.kind === 'unavailable' ? "can't do" : 'partly available'})`).join(', ')}{' '}
            in your availability. You can still offer, but double-check you can cover{' '}
            {clashes.length === 1 ? 'it' : 'them'}.
          </Text>
        </Alert>
      )}
      <Radio.Group value={mode} onChange={(v) => setMode(v as 'cover' | 'swap')}>
        <Stack gap="xs">
          <Radio value="swap" label="Swap: I'll take it if they take some of my days" disabled={!myShifts.length} />
          <Radio value="cover" label="Cover: I'll just take it" />
        </Stack>
      </Radio.Group>
      {mode === 'swap' && (
        <>
          <SlotPicker
            shifts={myShifts}
            tz={team.timezone}
            onChange={setSlots}
            marked={requested}
            warn={cant}
            mine={mine}
          />
          <Group gap="md">
            <Group gap={6}>
              <span className="ag-legend-swatch" style={{ borderColor: 'var(--mantine-color-grape-5)', borderStyle: 'dashed', borderWidth: 2 }} />
              <Text size="xs" c="dimmed">
                Needs cover
              </Text>
            </Group>
            {cant.size > 0 && (
              <Group gap={6}>
                <span className="ag-legend-swatch" style={{ background: 'var(--mantine-color-orange-light)', borderColor: 'var(--mantine-color-orange-6)' }} />
                <Text size="xs" c="dimmed">
                  {first} can't do
                </Text>
              </Group>
            )}
            {mine.size > 0 && (
              <Group gap={6}>
                <span className="ag-legend-swatch" style={{ background: 'var(--ag-unavailable)', borderColor: 'var(--ag-unavailable-strong)' }} />
                <Text size="xs" c="dimmed">
                  You can't do
                </Text>
              </Group>
            )}
            <Text size="xs" c="dimmed">
              Hover a day for details.
            </Text>
          </Group>
        </>
      )}
      <Textarea label="Note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <Group justify="flex-end">
        <Button
          onClick={() => offer.mutate(undefined)}
          loading={offer.isPending}
          disabled={mode === 'swap' && !slots.length}
        >
          Send offer
        </Button>
      </Group>
    </Stack>
  );
}
