import { Button, Card, Group, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCalendarDown, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { keys, useAction, useConfig, useMe } from '../api/hooks';
import { downloadOrToast, FeedUrl } from '../components/common';

export function ProfilePage() {
  const me = useMe();
  const config = useConfig();
  const [name, setName] = useState('');
  useEffect(() => {
    if (me.data) setName(me.data.display_name);
  }, [me.data]);

  const update = useAction((body: object) => api('/api/me', { method: 'PATCH', body }), {
    invalidate: [keys.me],
    success: 'Saved',
  });
  const rotate = useAction(() => api('/api/me/calendar-token', { method: 'POST' }), {
    invalidate: [keys.me],
    success: 'New calendar link created. Update any calendars subscribed to the old one.',
  });

  if (!me.data) return null;
  return (
    <Stack maw={720}>
      <Title order={2}>Profile & calendar</Title>
      <Card>
        <Stack>
          <TextInput label="Email" value={me.data.email} disabled description="Comes from your sign-in" />
          <Group align="flex-end">
            <TextInput
              label="Display name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button onClick={() => update.mutate({ display_name: name })} disabled={name === me.data.display_name}>
              Save
            </Button>
          </Group>
          <Switch
            label="Email me about date requests, published rotas and swaps"
            description={
              config.data?.email_enabled
                ? 'You always get in-app notifications.'
                : 'Email delivery is not configured on this server yet; in-app notifications still work.'
            }
            checked={me.data.email_notifications}
            onChange={(e) => update.mutate({ email_notifications: e.currentTarget.checked })}
          />
        </Stack>
      </Card>
      <Card>
        <Text fw={700}>Calendar</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Subscribe to this private link in Google Calendar, Outlook or Apple Calendar to keep your
          on-call shifts up to date automatically (including after swaps). Anyone with the link can
          see your shifts, so keep it private.
        </Text>
        <FeedUrl url={me.data.calendar_feed_url} />
        <Group mt="sm">
          <Button
            variant="light"
            leftSection={<IconCalendarDown size={16} />}
            onClick={() => downloadOrToast('/api/me/calendar.ics', 'my-on-call.ics')}
          >
            Download .ics (upcoming)
          </Button>
          <Button
            variant="subtle"
            leftSection={<IconCalendarDown size={16} />}
            onClick={() => downloadOrToast('/api/me/calendar.ics?include_past=true', 'my-on-call-all.ics')}
          >
            Include past shifts
          </Button>
          <Button
            variant="subtle"
            color="red"
            leftSection={<IconRefresh size={16} />}
            onClick={() =>
              modals.openConfirmModal({
                title: 'Reset your calendar link?',
                children: <Text size="sm">The old link stops working immediately.</Text>,
                labels: { confirm: 'Reset link', cancel: 'Cancel' },
                onConfirm: () => rotate.mutate(undefined),
              })
            }
          >
            Reset link
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
