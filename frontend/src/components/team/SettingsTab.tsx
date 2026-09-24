import {
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { keys, useAction, useHolidayCountries, useSpecialDays } from '../../api/hooks';
import type { TeamDetail } from '../../api/types';
import { DateInput } from '@mantine/dates';
import { dayjs, WEEKDAYS } from '../../lib/dates';
import { timezoneOptions } from '../../pages/TeamsPage';

export function SettingsTab({ team }: { team: TeamDetail }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: team.name,
    description: team.description,
    timezone: team.timezone,
    default_period_days: team.default_period_days,
    default_num_periods: team.default_num_periods,
    default_handover_weekday: team.default_handover_weekday,
    default_handover_time: team.default_handover_time,
    avoid_back_to_back: team.avoid_back_to_back,
    fairness_lookback_days: team.fairness_lookback_days,
    holiday_country: team.holiday_country,
    holiday_subdivision: team.holiday_subdivision,
  });
  const countries = useHolidayCountries();
  const country = countries.data?.find((c) => c.code === form.holiday_country);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useAction(() => api(`/api/teams/${team.id}`, { method: 'PATCH', body: form }), {
    invalidate: [keys.team(team.id), keys.teams, keys.me, keys.specialDays(team.id), keys.mySpecialDays, ['rotas']],
    success: 'Settings saved',
  });
  const del = useAction(() => api(`/api/teams/${team.id}`, { method: 'DELETE' }), {
    invalidate: [keys.teams, keys.me],
    onSuccess: () => navigate('/'),
  });

  return (
    <Stack maw={820}>
      <Card>
        <Text fw={700} mb="sm">
          Team
        </Text>
        <Stack>
          <TextInput label="Name" value={form.name} onChange={(e) => set('name', e.currentTarget.value)} />
          <Textarea
            label="Description"
            value={form.description}
            onChange={(e) => set('description', e.currentTarget.value)}
          />
          <Select
            label="Timezone"
            description="Used for new rotas. Existing rotas keep the timezone they were created with."
            data={timezoneOptions()}
            value={form.timezone}
            onChange={(v) => v && set('timezone', v)}
            searchable
          />
        </Stack>
      </Card>
      <Card>
        <Text fw={700} mb="sm">
          Defaults for new rotas
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput
            label="Period length (days)"
            description="How long each person's on-call stint is"
            min={1}
            max={90}
            value={form.default_period_days}
            onChange={(v) => set('default_period_days', Number(v) || 1)}
          />
          <NumberInput
            label="Periods to plan"
            description="E.g. 8 one-week periods = plan 8 weeks ahead"
            min={1}
            max={104}
            value={form.default_num_periods}
            onChange={(v) => set('default_num_periods', Number(v) || 1)}
          />
          <Select
            label="Handover day"
            data={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            value={String(form.default_handover_weekday)}
            onChange={(v) => set('default_handover_weekday', Number(v))}
            allowDeselect={false}
          />
          <TextInput
            label="Handover time"
            type="time"
            value={form.default_handover_time}
            onChange={(e) => set('default_handover_time', e.currentTarget.value)}
          />
        </SimpleGrid>
      </Card>
      <Card>
        <Text fw={700} mb="sm">
          Scheduling
        </Text>
        <Stack>
          <Switch
            label="Avoid back-to-back periods"
            description="Try not to give anyone two periods in a row (including across rotas)."
            checked={form.avoid_back_to_back}
            onChange={(e) => set('avoid_back_to_back', e.currentTarget.checked)}
          />
          <NumberInput
            label="Fairness look-back (days)"
            description="When balancing load, count on-call already done in this many days before the rota. 0 = only balance within each rota."
            min={0}
            max={3650}
            value={form.fairness_lookback_days}
            onChange={(v) => set('fairness_lookback_days', Number(v) || 0)}
          />
        </Stack>
      </Card>
      <Card>
        <Text fw={700}>Holidays & special days</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Unpopular days are shared out fairly over time when generating rotas, marked on the
          calendars, and leaders get history-based hints (e.g. who covered Christmas last year)
          when nobody can cover one.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="Public holidays for"
            placeholder="None"
            data={(countries.data ?? []).map((c) => ({ value: c.code, label: c.name }))}
            value={form.holiday_country || null}
            onChange={(v) => setForm((f) => ({ ...f, holiday_country: v ?? '', holiday_subdivision: '' }))}
            searchable
            clearable
            nothingFoundMessage="No match"
          />
          <Select
            label="Region"
            placeholder={country?.subdivisions.length ? 'Whole country' : 'Not applicable'}
            data={(country?.subdivisions ?? []).map((sd) => ({ value: sd.code, label: sd.name }))}
            value={form.holiday_subdivision || null}
            onChange={(v) => set('holiday_subdivision', v ?? '')}
            disabled={!country?.subdivisions.length}
            searchable
            clearable
          />
        </SimpleGrid>
        <SpecialDaysEditor team={team} />
      </Card>
      <Group justify="space-between">
        <Button
          color="red"
          variant="subtle"
          onClick={() =>
            modals.openConfirmModal({
              title: `Delete ${team.name}?`,
              children: (
                <Text size="sm">
                  This permanently deletes the team, all of its rotas and swap history. Export the
                  data first if you might need it.
                </Text>
              ),
              labels: { confirm: 'Delete team', cancel: 'Cancel' },
              confirmProps: { color: 'red' },
              onConfirm: () => del.mutate(undefined),
            })
          }
        >
          Delete team
        </Button>
        <Button onClick={() => save.mutate(undefined)} loading={save.isPending}>
          Save settings
        </Button>
      </Group>
    </Stack>
  );
}

function SpecialDaysEditor({ team }: { team: TeamDetail }) {
  const days = useSpecialDays(team.id);
  const [date, setDate] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const inv = [keys.specialDays(team.id), keys.mySpecialDays, ['rotas']];
  const add = useAction(
    () => api(`/api/teams/${team.id}/special-days`, { body: { date, label: label.trim() } }),
    {
      invalidate: inv,
      onSuccess: () => {
        setDate(null);
        setLabel('');
      },
    },
  );
  const remove = useAction(
    (id: number) => api(`/api/teams/${team.id}/special-days/${id}`, { method: 'DELETE' }),
    { invalidate: inv },
  );
  return (
    <Stack gap="xs" mt="md">
      <Text size="sm" fw={600}>
        Coming up
      </Text>
      {days.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No holidays or special days in the next year. Pick a country above or add your own.
        </Text>
      )}
      <Group gap={6}>
        {days.data?.slice(0, 24).map((d) => (
          <Badge
            key={`${d.source}-${d.date}`}
            variant={d.source === 'custom' ? 'filled' : 'light'}
            color="grape"
            size="lg"
            tt="none"
            rightSection={
              d.source === 'custom' && d.id != null ? (
                <CloseButton
                  size="xs"
                  variant="transparent"
                  c="white"
                  aria-label={`Remove ${d.label}`}
                  onClick={() => remove.mutate(d.id!)}
                />
              ) : undefined
            }
          >
            {dayjs(d.date).format('D MMM')} · {d.label}
          </Badge>
        ))}
      </Group>
      <Group align="flex-end" mt="xs">
        <DateInput
          label="Add a special day"
          placeholder="Date"
          value={date}
          onChange={setDate}
          valueFormat="ddd D MMM YYYY"
          w={200}
        />
        <TextInput
          label="Label"
          placeholder="e.g. Black Friday, code freeze"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <Button variant="light" disabled={!date || !label.trim()} loading={add.isPending} onClick={() => add.mutate(undefined)}>
          Add
        </Button>
      </Group>
    </Stack>
  );
}
