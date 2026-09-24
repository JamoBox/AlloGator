import {
  Badge,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconInfoCircle,
  IconStarFilled,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useHints } from '../../api/hooks';
import type { HintCandidate, HintItem } from '../../api/types';
import { fmtDate } from '../../lib/dates';
import { PersonChip } from '../common';

const TONE = {
  good: { color: 'gator', icon: IconCircleCheck },
  bad: { color: 'orange', icon: IconAlertTriangle },
  neutral: { color: 'gray', icon: IconInfoCircle },
} as const;

const AVAIL = {
  free: { color: 'gator', label: 'available' },
  partial: { color: 'orange', label: 'partly available' },
  unavailable: { color: 'red', label: "said they can't" },
} as const;

function HintLine({ hint }: { hint: HintItem }) {
  const t = TONE[hint.tone];
  const Icon = t.icon;
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Icon size={14} color={`var(--mantine-color-${t.color}-6)`} style={{ flexShrink: 0, marginTop: 2 }} />
      <Text size="xs" c={hint.tone === 'neutral' ? 'dimmed' : undefined}>
        {hint.text}
      </Text>
    </Group>
  );
}

function CandidateRow({
  c,
  onPick,
  pickLabel,
  busy,
}: {
  c: HintCandidate;
  onPick: (userId: number) => void;
  pickLabel: string;
  busy?: boolean;
}) {
  const hints = c.hints.filter((h) => h.kind !== 'availability');
  const avail = c.hints.find((h) => h.kind === 'availability');
  return (
    <Paper
      withBorder
      p="xs"
      radius="md"
      style={c.suggested ? { borderColor: 'var(--mantine-color-grape-4)', borderWidth: 2 } : undefined}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap={6}>
            <PersonChip user={{ id: c.user_id, name: c.name }} />
            {c.suggested && (
              <Badge color="grape" size="sm" leftSection={<IconStarFilled size={10} />}>
                Suggested
              </Badge>
            )}
            <Badge color={AVAIL[c.availability].color} variant="light" size="sm">
              {AVAIL[c.availability].label}
            </Badge>
          </Group>
          {avail && avail.tone !== 'good' && <HintLine hint={avail} />}
          {hints.map((h, i) => (
            <HintLine key={i} hint={h} />
          ))}
        </Stack>
        <Button size="compact-sm" variant={c.suggested ? 'filled' : 'light'} color="grape" onClick={() => onPick(c.user_id)} loading={busy}>
          {pickLabel}
        </Button>
      </Group>
    </Paper>
  );
}

/**
 * History-based hints for choosing who takes dates nobody can (or wants to) cover.
 * `compact` shows just the suggestion with a toggle to compare everyone.
 */
export function DecisionHelper({
  rotaId,
  from,
  to,
  onPick,
  pickLabel = 'Assign',
  compact = false,
  busy,
}: {
  rotaId: number;
  from: string;
  to: string;
  onPick: (userId: number) => void;
  pickLabel?: string;
  compact?: boolean;
  busy?: boolean;
}) {
  const hints = useHints(rotaId, from, to);
  const [open, setOpen] = useState(!compact);
  if (hints.isLoading) {
    return (
      <Stack gap={6}>
        <Skeleton h={18} w="60%" />
        <Skeleton h={52} />
      </Stack>
    );
  }
  if (!hints.data || !hints.data.candidates.length) {
    return <Text size="sm" c="dimmed">Nobody on this team is marked as taking part in on-call.</Text>;
  }
  const data = hints.data;
  const top = data.candidates[0];
  const labels = Object.entries(data.labels);
  return (
    <Stack gap={6}>
      {labels.length > 0 && (
        <Text size="xs" c="grape.7" fw={600}>
          🎉 {labels.map(([d, l]) => `${fmtDate(d)}: ${l}`).join(' · ')}
        </Text>
      )}
      {compact && !open ? (
        <Paper withBorder p="xs" radius="md" style={{ borderColor: 'var(--mantine-color-grape-4)' }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: '1 1 260px' }}>
              <ThemeIcon size="sm" radius="xl" color="grape" variant="light">
                <IconStarFilled size={12} />
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <Text size="sm">
                  Suggested: <b>{top.name}</b>
                </Text>
                {top.why.length > 0 && (
                  <Text size="xs" c="dimmed" truncate>
                    {top.why.join(' · ')}
                  </Text>
                )}
              </div>
            </Group>
            <Group gap={6} wrap="nowrap">
              <Button size="compact-sm" color="grape" onClick={() => onPick(top.user_id)} loading={busy}>
                {pickLabel} {top.name.split(' ')[0]}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                rightSection={<IconChevronDown size={14} />}
                onClick={() => setOpen(true)}
              >
                Compare everyone
              </Button>
            </Group>
          </Group>
        </Paper>
      ) : (
        <>
          {data.everyone_unavailable && (
            <Text size="xs" c="dimmed">
              Everyone has said they can't do this, so here's what the history says about who
              should take it.
            </Text>
          )}
          {data.candidates.map((c) => (
            <CandidateRow key={c.user_id} c={c} onPick={onPick} pickLabel={pickLabel} busy={busy} />
          ))}
          {compact && (
            <UnstyledButton onClick={() => setOpen(false)}>
              <Group gap={4}>
                <IconChevronUp size={14} />
                <Text size="xs" c="dimmed">
                  Show less
                </Text>
              </Group>
            </UnstyledButton>
          )}
        </>
      )}
    </Stack>
  );
}
