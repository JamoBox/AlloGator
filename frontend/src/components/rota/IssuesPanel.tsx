import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import type { Analysis, Candidate, Issue, User } from '../../api/types';
import { fmtDate } from '../../lib/dates';
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
  remind: () => void;
}

export function IssuesPanel({
  rotaId,
  analysis,
  people,
  editable,
  actions,
}: {
  rotaId: number;
  analysis: Analysis;
  people: User[];
  editable: boolean;
  actions?: IssueActions;
}) {
  const name = (id: number) => people.find((p) => p.id === id)?.name ?? `#${id}`;
  if (analysis.issues.length === 0) {
    return (
      <CrocEmpty
        sleepy
        title="Nothing to chew on"
        description="Everyone is covered, nobody is scheduled when they said they can't be, and there's no partial cover."
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
                Partial cover is normally avoided; it was used because nobody else could cover the
                whole period.
              </Text>
            )}
            {editable &&
              actions &&
              (issue.type === 'uncovered' || issue.type === 'conflict') &&
              !issue.decided &&
              issue.start_date &&
              issue.end_date && (
                <DecisionHelper
                  rotaId={rotaId}
                  from={issue.start_date}
                  to={issue.end_date}
                  compact
                  onPick={(uid) => actions.assignDates(uid, issue.start_date!, issue.end_date!)}
                />
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
