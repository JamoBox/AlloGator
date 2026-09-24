import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  NumberInput,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { keys, useAction, usePrefetch, useRotaDefaults, useRotas } from '../../api/hooks';
import type { RotaDetail, TeamDetail } from '../../api/types';
import { dayjs, fmtDateRange, ISO } from '../../lib/dates';
import { RotaStatusBadge } from '../common';

export function RotasTab({ team }: { team: TeamDetail }) {
  const rotas = useRotas(team.id);
  const navigate = useNavigate();
  const prefetch = usePrefetch();
  const [opened, modal] = useDisclosure(false);
  const today = dayjs().format(ISO);

  if (rotas.isLoading) return <Loader />;
  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Each rota covers a run of on-call periods. Leaders collect availability, generate a
          schedule, review it and publish.
        </Text>
        {team.is_leader && (
          <Button leftSection={<IconPlus size={16} />} onClick={modal.open}>
            Plan a new rota
          </Button>
        )}
      </Group>
      <Card p={0}>
        <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Dates</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Periods</Table.Th>
                <Table.Th>Availability</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rotas.data?.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dimmed" size="sm" ta="center" py="md">
                      No rotas yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {rotas.data?.map((r) => {
                const current = r.start_date <= today && today <= r.end_date;
                const past = r.end_date < today;
                return (
                  <Table.Tr
                    key={r.id}
                    style={{ cursor: 'pointer', opacity: past ? 0.7 : 1 }}
                    onClick={() => navigate(`/teams/${team.id}/rotas/${r.id}`)}
                    onMouseEnter={() => prefetch.rota(r.id, team.is_leader)}
                  >
                    <Table.Td>
                      <Text fw={600} size="sm">
                        {r.name || fmtDateRange(r.start_date, r.end_date)}
                      </Text>
                      {r.name && (
                        <Text size="xs" c="dimmed">
                          {fmtDateRange(r.start_date, r.end_date)}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6}>
                        <RotaStatusBadge status={r.status} />
                        {current && r.status === 'published' && (
                          <Badge variant="dot" color="gator">
                            current
                          </Badge>
                        )}
                        {r.imported && (
                          <Badge variant="outline" color="gray" size="xs">
                            imported
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {r.num_periods} × {r.period_days} day{r.period_days === 1 ? '' : 's'}
                      </Text>
                    </Table.Td>
                    <Table.Td w={200}>
                      {r.status === 'collecting' || r.status === 'review' ? (
                        <Stack gap={2}>
                          <Text size="xs">
                            {r.submitted_count}/{r.eligible_count} confirmed
                          </Text>
                          <Progress
                            value={(100 * r.submitted_count) / Math.max(1, r.eligible_count)}
                            size="sm"
                          />
                        </Stack>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.open_swaps > 0 && (
                        <Badge color="grape" variant="light">
                          {r.open_swaps} swap request{r.open_swaps > 1 ? 's' : ''}
                        </Badge>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Modal opened={opened} onClose={modal.close} title="Plan a new rota" size="md">
        {opened && <NewRotaForm team={team} onDone={modal.close} />}
      </Modal>
    </Stack>
  );
}

function NewRotaForm({ team, onDone }: { team: TeamDetail; onDone: () => void }) {
  const defaults = useRotaDefaults(team.id);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [start, setStart] = useState<string | null>(null);
  const [periods, setPeriods] = useState<number>(team.default_num_periods);
  const [periodDays, setPeriodDays] = useState<number>(team.default_period_days);
  const [handover, setHandover] = useState(team.default_handover_time);

  useEffect(() => {
    if (defaults.data && start === null) setStart(defaults.data.start_date);
  }, [defaults.data, start]);

  const create = useAction(
    () =>
      api<RotaDetail>(`/api/teams/${team.id}/rotas`, {
        body: {
          name,
          start_date: start,
          num_periods: periods,
          period_days: periodDays,
          handover_time: handover,
        },
      }),
    {
      invalidate: [keys.rotas(team.id), keys.todo],
      onSuccess: (rota) => {
        onDone();
        navigate(`/teams/${team.id}/rotas/${rota.id}`);
      },
    },
  );

  const end = start ? dayjs(start).add(periods * periodDays - 1, 'day').format(ISO) : null;
  const weeks = (periods * periodDays) / 7;

  return (
    <Stack>
      <DateInput
        label="First day"
        description={`Handover happens at the start of each period (${handover}, ${team.timezone})`}
        value={start}
        onChange={setStart}
        valueFormat="ddd D MMM YYYY"
        required
      />
      <Group grow>
        <NumberInput
          label="Number of periods"
          min={1}
          max={104}
          value={periods}
          onChange={(v) => setPeriods(Number(v) || 1)}
        />
        <NumberInput
          label="Period length (days)"
          description="How long each on-call stint is"
          min={1}
          max={90}
          value={periodDays}
          onChange={(v) => setPeriodDays(Number(v) || 1)}
        />
      </Group>
      <TextInput
        label="Handover time"
        type="time"
        value={handover}
        onChange={(e) => setHandover(e.currentTarget.value)}
      />
      <TextInput
        label="Name (optional)"
        placeholder="e.g. Q4 2026"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      {start && end && (
        <Text size="sm" c="dimmed">
          Covers {fmtDateRange(start, end)} — {periods} period{periods > 1 ? 's' : ''}
          {Number.isInteger(weeks) ? ` (${weeks} week${weeks > 1 ? 's' : ''})` : ''}.
        </Text>
      )}
      <Group justify="flex-end">
        <Button onClick={() => create.mutate(undefined)} loading={create.isPending} disabled={!start}>
          Create rota
        </Button>
      </Group>
    </Stack>
  );
}
