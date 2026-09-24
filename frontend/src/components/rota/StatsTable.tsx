import { Badge, Progress, Table, Text, Tooltip } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { Analysis } from '../../api/types';
import { personColor } from '../../lib/people';
import { PersonChip } from '../common';

export function StatsTable({ analysis, showSubmitted }: { analysis: Analysis; showSubmitted: boolean }) {
  const rows = analysis.stats.filter((s) => s.on_call || s.days > 0);
  const max = Math.max(1, ...rows.map((s) => s.days + s.history_days));
  return (
    <Table.ScrollContainer minWidth={620}>
      <Table verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Person</Table.Th>
            <Table.Th>
              <Tooltip label="On-call days in this rota" withArrow>
                <span>Days</span>
              </Tooltip>
            </Table.Th>
            <Table.Th>Periods</Table.Th>
            <Table.Th>
              <Tooltip label="Days covering part of someone else's period" withArrow>
                <span>Cover</span>
              </Tooltip>
            </Table.Th>
            <Table.Th>
              <Tooltip label="On-call days in recent rotas (the fairness look-back)" withArrow>
                <span>Recent</span>
              </Tooltip>
            </Table.Th>
            <Table.Th w={180}>Load (recent + this rota)</Table.Th>
            <Table.Th>Unavailable</Table.Th>
            {showSubmitted && <Table.Th>Dates in</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((s) => (
            <Table.Tr key={s.user_id}>
              <Table.Td>
                <PersonChip user={{ id: s.user_id, name: s.name }} muted={!s.on_call} />
              </Table.Td>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {s.days}
                </Text>
              </Table.Td>
              <Table.Td>{s.periods_owned}</Table.Td>
              <Table.Td>{s.cover_days || '—'}</Table.Td>
              <Table.Td>{s.history_days || '—'}</Table.Td>
              <Table.Td>
                <Progress.Root size="lg">
                  <Tooltip label={`Recent: ${s.history_days} days`}>
                    <Progress.Section value={(100 * s.history_days) / max} color="gray.4" />
                  </Tooltip>
                  <Tooltip label={`This rota: ${s.days} days`}>
                    <Progress.Section value={(100 * s.days) / max} color={personColor(s.user_id)} />
                  </Tooltip>
                </Progress.Root>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {s.unavailable_days}
                  {s.partial_days ? ` (+${s.partial_days} partly)` : ''}
                </Text>
                {s.conflict_days > 0 && (
                  <Badge color="red" size="xs">
                    {s.conflict_days} conflict{s.conflict_days > 1 ? 's' : ''}
                  </Badge>
                )}
              </Table.Td>
              {showSubmitted && (
                <Table.Td>{s.submitted ? <IconCheck size={16} color="var(--mantine-color-gator-6)" /> : '—'}</Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
