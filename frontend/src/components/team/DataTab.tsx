import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  FileInput,
  Group,
  List,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconCalendarDown,
  IconFileSpreadsheet,
  IconFileTypeCsv,
  IconJson,
  IconUpload,
} from '@tabler/icons-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { keys, useAction } from '../../api/hooks';
import type { ImportReport, TeamDetail } from '../../api/types';
import { fmtDateRange } from '../../lib/dates';
import { downloadOrToast } from '../common';

export function DataTab({ team }: { team: TeamDetail }) {
  const base = `/api/teams/${team.id}/export`;
  const slug = team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <Stack>
      <Card>
        <Text fw={700}>Export</Text>
        <Text size="sm" c="dimmed" mb="sm">
          {team.is_leader
            ? 'Every rota for this team (historic, current, upcoming and drafts).'
            : 'Every published rota for this team.'}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Button
            variant="light"
            leftSection={<IconJson size={18} />}
            onClick={() => downloadOrToast(`${base}?format=json`, `${slug}.json`)}
          >
            JSON (full backup)
          </Button>
          <Button
            variant="light"
            leftSection={<IconFileTypeCsv size={18} />}
            onClick={() => downloadOrToast(`${base}?format=csv`, `${slug}.csv`)}
          >
            CSV (spreadsheet)
          </Button>
          <Button
            variant="light"
            leftSection={<IconCalendarDown size={18} />}
            onClick={() => downloadOrToast(`${base}?format=ics`, `${slug}.ics`)}
          >
            Calendar (.ics)
          </Button>
        </SimpleGrid>
      </Card>
      {team.is_leader && <ImportCard team={team} />}
    </Stack>
  );
}

function ImportCard({ team }: { team: TeamDetail }) {
  const [file, setFile] = useState<File | null>(null);
  const [onConflict, setOnConflict] = useState('skip');
  const [asDraft, setAsDraft] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const run = useAction(
    (dryRun: boolean) => {
      const form = new FormData();
      form.append('file', file!);
      form.append('dry_run', String(dryRun));
      form.append('on_conflict', onConflict);
      form.append('as_draft', String(asDraft));
      return api<ImportReport>(`/api/teams/${team.id}/import`, { form });
    },
    {
      invalidate: (r) => (r.dry_run ? [] : [keys.rotas(team.id), keys.team(team.id), keys.schedule(team.id)]),
      success: (r) => (r.dry_run ? null : 'Import complete'),
      onSuccess: (r) => setReport(r),
    },
  );

  return (
    <Card>
      <Text fw={700}>Import</Text>
      <Text size="sm" c="dimmed" mb="sm">
        Load schedules from an AlloGator JSON export, or from a CSV with at least the columns{' '}
        <Code>start</Code>, <Code>end</Code> and <Code>user_email</Code> (optionally{' '}
        <Code>rota</Code>, <Code>user_name</Code>, <Code>note</Code>). Times are ISO 8601, e.g.{' '}
        <Code>2026-10-05T09:00</Code> (interpreted in {team.timezone} unless they include an
        offset). Unknown people are added to the team.
      </Text>
      <Stack>
        <FileInput
          label="File"
          placeholder="Choose a .json or .csv file"
          accept=".json,.csv,application/json,text/csv"
          leftSection={<IconFileSpreadsheet size={16} />}
          value={file}
          onChange={(f) => {
            setFile(f);
            setReport(null);
          }}
          clearable
        />
        <Group>
          <div>
            <Text size="sm" fw={500}>
              If a rota overlaps an existing one
            </Text>
            <SegmentedControl
              value={onConflict}
              onChange={(v) => {
                setOnConflict(v);
                setReport(null);
              }}
              data={[
                { value: 'skip', label: 'Skip it' },
                { value: 'replace', label: 'Replace existing' },
                { value: 'keep_both', label: 'Keep both' },
              ]}
            />
          </div>
          <Checkbox
            label="Import as drafts (not published)"
            checked={asDraft}
            onChange={(e) => {
              setAsDraft(e.currentTarget.checked);
              setReport(null);
            }}
            mt="lg"
          />
        </Group>
        <Group>
          <Button variant="default" disabled={!file} loading={run.isPending} onClick={() => run.mutate(true)}>
            Preview
          </Button>
          <Button
            leftSection={<IconUpload size={16} />}
            disabled={!file || !report?.dry_run}
            loading={run.isPending}
            onClick={() => run.mutate(false)}
          >
            Import
          </Button>
        </Group>
        {report && <ReportView report={report} />}
      </Stack>
    </Card>
  );
}

function ReportView({ report }: { report: ImportReport }) {
  const colors = { create: 'gator', skip: 'gray', replace: 'orange' } as const;
  return (
    <Alert color={report.dry_run ? 'blue' : 'gator'} title={report.dry_run ? 'Preview — nothing saved yet' : 'Imported'}>
      <Stack gap="xs">
        <Table withTableBorder={false} verticalSpacing={4}>
          <Table.Tbody>
            {report.rotas.map((r, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <Badge color={colors[r.action]} variant="light">
                    {r.action}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={600}>
                    {r.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {fmtDateRange(r.start_date, r.end_date)} · {r.num_periods} × {r.period_days} days
                    · {r.shifts} shifts
                  </Text>
                </Table.Td>
                <Table.Td>
                  {r.overlaps.length > 0 && (
                    <Text size="xs" c="orange">
                      Overlaps {r.overlaps.map((o) => o.name).join(', ')}
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {report.new_members.length > 0 && (
          <Text size="sm">
            {report.dry_run ? 'Will add' : 'Added'} to the team: {report.new_members.join(', ')}
          </Text>
        )}
        {report.warnings.length > 0 && (
          <List size="sm">
            {report.warnings.map((w) => (
              <List.Item key={w}>{w}</List.Item>
            ))}
          </List>
        )}
      </Stack>
    </Alert>
  );
}
