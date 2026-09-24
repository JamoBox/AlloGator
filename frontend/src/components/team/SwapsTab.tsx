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
  Select,
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
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { keys, useAction, useMe, useMyShifts, useSwaps } from '../../api/hooks';
import type { ScheduleShift, SwapRequest, TeamDetail } from '../../api/types';
import { dayjs, fmtDateTime, fromNow, inTz, toLocalInput } from '../../lib/dates';
import { PersonChip } from '../common';

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

export interface Slot {
  rota_id: number;
  start_at: string;
  end_at: string;
}

/** Pick all or part of one of your shifts: whole days, or exact times. */
export function SlotPicker({
  shifts,
  tz,
  onChange,
  initialShiftId,
  initialDate,
}: {
  shifts: ScheduleShift[];
  tz: string;
  onChange: (slot: Slot | null) => void;
  initialShiftId?: number;
  initialDate?: string;
}) {
  const [shiftId, setShiftId] = useState<string | null>(
    initialShiftId ? String(initialShiftId) : shifts[0] ? String(shifts[0].id) : null,
  );
  const shift = shifts.find((s) => String(s.id) === shiftId);

  // Day boundaries inside the shift, keeping local wall-clock time across DST changes.
  const points = useMemo(() => {
    if (!shift) return [] as string[];
    const start = inTz(shift.start_at, tz);
    const end = dayjs(shift.end_at);
    const out = [shift.start_at];
    for (let i = 1; i < 400; i++) {
      const date = dayjs(start.format('YYYY-MM-DD')).add(i, 'day').format('YYYY-MM-DD');
      const p = dayjs.tz(`${date}T${start.format('HH:mm')}`, tz);
      if (!p.isBefore(end)) break;
      out.push(p.format());
    }
    out.push(shift.end_at);
    return out;
  }, [shift, tz]);

  const [fromIdx, setFromIdx] = useState(0);
  const [toIdx, setToIdx] = useState(0);
  const [custom, setCustom] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  useEffect(() => {
    let from = 0;
    if (initialDate && shift?.id === initialShiftId) {
      const i = points.findIndex((p) => inTz(p, tz).format('YYYY-MM-DD') === initialDate);
      if (i >= 0 && i < points.length - 1) from = i;
    }
    setFromIdx(from);
    setToIdx(initialDate && from > 0 ? from : Math.max(0, points.length - 2));
    setCustom(false);
  }, [points, initialDate, initialShiftId, shift?.id, tz]);

  const dayOptions = points.slice(0, -1).map((p, i) => ({
    value: String(i),
    label: `${inTz(p, tz).format('ddd D MMM')} (${inTz(p, tz).format('HH:mm')} → ${inTz(points[i + 1], tz).format('ddd HH:mm')})`,
  }));

  const computedStart = points[fromIdx];
  const computedEnd = points[Math.max(fromIdx, toIdx) + 1];

  useEffect(() => {
    if (computedStart && computedEnd) {
      setCustomStart(toLocalInput(computedStart, tz));
      setCustomEnd(toLocalInput(computedEnd, tz));
    }
  }, [computedStart, computedEnd, tz]);

  useEffect(() => {
    if (!shift || !computedStart || !computedEnd) return onChange(null);
    if (custom) {
      if (!customStart || !customEnd || customEnd <= customStart) return onChange(null);
      onChange({ rota_id: shift.rota_id, start_at: customStart, end_at: customEnd });
    } else {
      onChange({ rota_id: shift.rota_id, start_at: computedStart, end_at: computedEnd });
    }
  }, [shift, computedStart, computedEnd, custom, customStart, customEnd]);

  if (shifts.length === 0) {
    return <Text c="dimmed">You have no upcoming shifts in this team.</Text>;
  }
  return (
    <Stack gap="sm">
      <Select
        label="Shift"
        data={shifts.map((s) => ({
          value: String(s.id),
          label: `${fmtDateTime(s.start_at, tz)} → ${fmtDateTime(s.end_at, tz)}`,
        }))}
        value={shiftId}
        onChange={setShiftId}
        allowDeselect={false}
      />
      {dayOptions.length > 1 && (
        <Group grow>
          <Select
            label="From"
            data={dayOptions}
            value={String(fromIdx)}
            onChange={(v) => {
              const i = Number(v);
              setFromIdx(i);
              if (toIdx < i) setToIdx(i);
            }}
            allowDeselect={false}
          />
          <Select
            label="To (inclusive)"
            data={dayOptions.filter((o) => Number(o.value) >= fromIdx)}
            value={String(Math.max(fromIdx, toIdx))}
            onChange={(v) => setToIdx(Number(v))}
            allowDeselect={false}
          />
        </Group>
      )}
      <Checkbox
        label="Only part of a day — set exact times"
        checked={custom}
        onChange={(e) => setCustom(e.currentTarget.checked)}
      />
      {custom && (
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
  const [slot, setSlot] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const create = useAction(() => api<SwapRequest>('/api/swaps', { body: { ...slot, note } }), {
    invalidate: [keys.swaps(team.id, false), keys.swaps(team.id, true), keys.todo],
    success: 'Swap request sent to your team',
    onSuccess: onDone,
  });
  return (
    <Stack>
      <SlotPicker
        shifts={shifts}
        tz={team.timezone}
        onChange={setSlot}
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
        <Button onClick={() => create.mutate(undefined)} disabled={!slot} loading={create.isPending}>
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
  const [offerOpen, offerModal] = useDisclosure(false);
  const isRequester = me.data?.id === swap.requester.id;
  const canManage = isRequester || team.is_leader;
  const tz = team.timezone;
  const inv = [keys.swaps(team.id, false), keys.swaps(team.id, true), keys.todo, keys.myShifts, keys.schedule(team.id), keys.rota(swap.rota_id)];

  const act = useAction(
    (a: { path: string; msg: string }) => api<SwapRequest>(`/api/swaps/${swap.id}${a.path}`, { method: 'POST' }),
    { invalidate: inv, success: (_, a) => a.msg },
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
          <Text fw={600}>
            {fmtDateTime(swap.start_at, tz)} → {fmtDateTime(swap.end_at, tz)}
          </Text>
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
                    {o.start_at && o.end_at ? (
                      <>
                        Takes your slot and gives you{' '}
                        <b>
                          {fmtDateTime(o.start_at, tz)} → {fmtDateTime(o.end_at, tz)}
                        </b>
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
  const [slot, setSlot] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const offer = useAction(
    () =>
      api<SwapRequest>(`/api/swaps/${swap.id}/offers`, {
        body: mode === 'swap' ? { ...slot, note } : { note },
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
        {swap.requester.name} needs cover for{' '}
        <b>
          {fmtDateTime(swap.start_at, team.timezone)} → {fmtDateTime(swap.end_at, team.timezone)}
        </b>
        .
      </Text>
      <Radio.Group value={mode} onChange={(v) => setMode(v as 'cover' | 'swap')}>
        <Stack gap="xs">
          <Radio value="swap" label="Swap: I'll take it if they take one of my slots" disabled={!myShifts.length} />
          <Radio value="cover" label="Cover: I'll just take it" />
        </Stack>
      </Radio.Group>
      {mode === 'swap' && <SlotPicker shifts={myShifts} tz={team.timezone} onChange={setSlot} />}
      <Textarea label="Note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      <Group justify="flex-end">
        <Button
          onClick={() => offer.mutate(undefined)}
          loading={offer.isPending}
          disabled={mode === 'swap' && !slot}
        >
          Send offer
        </Button>
      </Group>
    </Stack>
  );
}
