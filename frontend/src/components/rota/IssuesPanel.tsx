import {
  Alert,
  Badge,
  Button,
  Chip,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconCut, IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import type { Analysis, Candidate, Issue, RotaDetail } from '../../api/types';
import { eachDay, fmtDate, fmtDateRange, groupRuns, toLocalInput } from '../../lib/dates';
import type { AssignBody } from '../../lib/rota';
import { CrocEmpty } from '../brand';
import { DecisionHelper } from './DecisionHelper';

const ICON = {
  error: <IconAlertCircle size={18} />,
  warning: <IconAlertTriangle size={18} />,
  info: <IconInfoCircle size={18} />,
};
const COLOR = { error: 'red', warning: 'orange', info: 'blue' };

export interface IssueActions {
  assignDates: (userId: number, from: string, to: string) => void;
  assignPeriod: (userId: number, periodIndex: number) => void;
  assign: (body: AssignBody) => Promise<unknown>;
  remind: () => void;
}

export function IssuesPanel({
  rota,
  analysis,
  editable,
  actions,
}: {
  rota: RotaDetail;
  analysis: Analysis;
  editable: boolean;
  actions?: IssueActions;
}) {
  const rotaId = rota.id;
  const name = (id: number) => rota.people.find((p) => p.id === id)?.name ?? `#${id}`;
  if (analysis.issues.length === 0) {
    return (
      <CrocEmpty
        sleepy
        title="Nothing to chew on"
        description="Everyone is covered and nobody is scheduled when they said they can't be."
      />
    );
  }
  const order = { error: 0, warning: 1, info: 2 };
  const issues = [...analysis.issues].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <Stack gap="xs">
      {issues.map((issue) => (
        <Alert
          key={issue.id}
          color={COLOR[issue.severity]}
          icon={ICON[issue.severity]}
          title={issue.title}
          p="sm"
        >
          <Stack gap={6}>
            {issue.detail && <Text size="sm">{issue.detail}</Text>}
            {issue.decided && (
              <Text size="xs" c="dimmed">
                A leader assigned this, so it isn't counted as a problem.
              </Text>
            )}
            {issue.type === 'partial_cover' && issue.covers && !issue.decided && (
              <Text size="xs" c="dimmed">
                The solver avoids splitting a period where it can, so this is usually the best fit
                available. Nothing to decide unless you'd rather give the whole period to one person.
              </Text>
            )}
            {editable &&
              actions &&
              (issue.type === 'uncovered' || issue.type === 'conflict') &&
              !issue.decided &&
              issue.start_date &&
              issue.end_date && (
                <>
                  <DecisionHelper
                    rotaId={rotaId}
                    from={issue.start_date}
                    to={issue.end_date}
                    compact
                    onPick={(uid) => actions.assignDates(uid, issue.start_date!, issue.end_date!)}
                  />
                  <PartialAssign rota={rota} issue={issue} name={name} onAssign={actions.assign} />
                </>
              )}
            {editable && actions && <IssueFixes issue={issue} name={name} actions={actions} />}
            {!editable && issue.candidates && issue.candidates.length > 0 && (
              <CandidateNotes candidates={issue.candidates} name={name} />
            )}
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}

function IssueFixes({
  issue,
  name,
  actions,
}: {
  issue: Issue;
  name: (id: number) => string;
  actions: IssueActions;
}) {
  if (issue.type === 'unsubmitted') {
    return (
      <Group>
        <Button size="xs" variant="light" onClick={actions.remind}>
          Send a reminder
        </Button>
      </Group>
    );
  }
  const cands = issue.candidates ?? [];
  if (!cands.length) return null;
  if (issue.type === 'partial_cover' && issue.period_index !== undefined && !issue.decided) {
    return (
      <Group gap="xs">
        <Text size="xs">Give the whole period to:</Text>
        {cands.map((c) => (
          <Button key={c.user_id} size="compact-xs" variant="light" onClick={() => actions.assignPeriod(c.user_id, issue.period_index!)}>
            {name(c.user_id)}
          </Button>
        ))}
      </Group>
    );
  }
  return null;
}

function CandidateNotes({ candidates, name }: { candidates: Candidate[]; name: (id: number) => string }) {
  const withNotes = candidates.filter((c) => c.notes.some((n) => n.note));
  if (!withNotes.length) return null;
  return (
    <Stack gap={2}>
      {withNotes.map((c) => (
        <Text key={c.user_id} size="xs">
          <Badge size="xs" variant="outline" mr={4}>
            {name(c.user_id)}
          </Badge>
          {c.notes
            .filter((n) => n.note)
            .map((n) => `${fmtDate(n.date)}: ${n.note}`)
            .join(' · ')}
        </Text>
      ))}
    </Stack>
  );
}

const AVAIL_MARK = { unavailable: ' ✕', partial: ' ~' } as const;

/**
 * Cover some of an issue's days (or part of a day) with one person, leaving the rest for
 * someone else: e.g. when nobody can do the whole run.
 */
function PartialAssign({
  rota,
  issue,
  name,
  onAssign,
}: {
  rota: RotaDetail;
  issue: Issue;
  name: (id: number) => string;
  onAssign: (body: AssignBody) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Group>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconCut size={14} />}
          onClick={() => setOpen(true)}
        >
          Split it: assign some days or hours
        </Button>
      </Group>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title={`Cover part of ${fmtDateRange(issue.start_date!, issue.end_date!)}`}
      >
        {open && <PartialAssignForm rota={rota} issue={issue} name={name} onAssign={onAssign} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function PartialAssignForm({
  rota,
  issue,
  name,
  onAssign,
  onDone,
}: {
  rota: RotaDetail;
  issue: Issue;
  name: (id: number) => string;
  onAssign: (body: AssignBody) => Promise<unknown>;
  onDone: () => void;
}) {
  const dates = eachDay(issue.start_date!, issue.end_date!);
  const cands = issue.candidates ?? [];
  const byUser = new Map(cands.map((c) => [c.user_id, c]));
  const excluded = new Set(issue.type === 'conflict' ? (issue.user_ids ?? []) : []);
  const options = [
    ...cands.filter((c) => !excluded.has(c.user_id)).map((c) => ({
      value: String(c.user_id),
      label: `${name(c.user_id)} — free ${c.free_days}/${c.total_days} day${c.total_days > 1 ? 's' : ''}`,
    })),
    ...rota.people
      .filter((p) => !byUser.has(p.id) && !excluded.has(p.id))
      .map((p) => ({ value: String(p.id), label: p.name })),
  ];
  const [who, setWho] = useState<string | null>(options[0]?.value ?? null);
  const [mode, setMode] = useState<'days' | 'times'>(dates.length > 1 ? 'days' : 'times');
  const [picked, setPicked] = useState<string[]>([]);
  const dayOf = (d: string) => rota.days.find((x) => x.date === d);
  const [start, setStart] = useState(
    toLocalInput(issue.start_at ?? dayOf(issue.start_date!)?.start_at ?? '', rota.timezone),
  );
  const [end, setEnd] = useState(toLocalInput(issue.end_at ?? dayOf(issue.end_date!)?.end_at ?? '', rota.timezone));
  const [busy, setBusy] = useState(false);

  const cand = who ? byUser.get(Number(who)) : undefined;
  const mark = (d: string) => {
    const n = cand?.notes.find((x) => x.date === d);
    return n ? AVAIL_MARK[n.kind] : '';
  };
  const runs = groupRuns(picked.map((date) => ({ date })));
  const valid = !!who && (mode === 'days' ? picked.length > 0 : !!start && !!end && end > start);

  const submit = async () => {
    if (!who) return;
    setBusy(true);
    try {
      if (mode === 'days') {
        for (const r of runs)
          await onAssign({ user_id: Number(who), from_date: r[0].date, to_date: r[r.length - 1].date });
      } else {
        await onAssign({ user_id: Number(who), start_at: start, end_at: end });
      }
      onDone();
    } catch {
      // useAction has already shown the error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Select label="Who" data={options} value={who} onChange={setWho} allowDeselect={false} searchable />
      {dates.length > 1 && (
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as 'days' | 'times')}
          data={[
            { value: 'days', label: 'Some of the days' },
            { value: 'times', label: 'Exact times' },
          ]}
        />
      )}
      {mode === 'days' ? (
        <Stack gap={6}>
          <Chip.Group multiple value={picked} onChange={setPicked}>
            <Group gap={6}>
              {dates.map((d) => (
                <Chip key={d} value={d} size="sm" color={mark(d) ? 'orange' : undefined}>
                  {fmtDate(d)}
                  {mark(d)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          {cand && cand.notes.length > 0 && (
            <Text size="xs" c="dimmed">
              {name(cand.user_id)}:{' '}
              {cand.notes
                .map((n) => `${fmtDate(n.date)} ${n.kind === 'unavailable' ? "can't" : 'partly'}${n.note ? ` (${n.note})` : ''}`)
                .join(' · ')}
            </Text>
          )}
        </Stack>
      ) : (
        <Group grow>
          <TextInput
            type="datetime-local"
            label={`From (${rota.timezone})`}
            value={start}
            onChange={(e) => setStart(e.currentTarget.value)}
          />
          <TextInput type="datetime-local" label="To" value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
        </Group>
      )}
      <Text size="xs" c="dimmed">
        {mode === 'days'
          ? 'Whole days, handover to handover. Anything you leave out stays on the list to cover.'
          : 'For part of a day, e.g. someone covering 13:00–17:00. The rest stays on the list to cover.'}
      </Text>
      <Group justify="flex-end">
        <Button onClick={submit} loading={busy} disabled={!valid}>
          {mode === 'days' && runs.length
            ? `Assign ${runs.map((r) => fmtDateRange(r[0].date, r[r.length - 1].date)).join(', ')}`
            : 'Assign'}
        </Button>
      </Group>
    </Stack>
  );
}
