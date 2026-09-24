import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconFlask, IconMail, IconSeeding, IconUserCircle } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getDevUser, setDevUser } from '../api/client';
import { useDevUsers, useMe } from '../api/hooks';

interface OutboxMail {
  to: string;
  subject: string;
  text: string;
  link: string;
  created_at: string;
}

/** Dev-mode only: act as any user, seed demo data and read the emails that would be sent. */
export function DevUserSwitcher() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useDevUsers(true);
  const [email, setEmail] = useState('');
  const [outboxOpen, outbox] = useDisclosure(false);

  const switchTo = (value: string | null) => {
    setDevUser(value);
    qc.clear();
    window.location.assign('/');
  };

  const seed = async () => {
    const res = await api<{ status: string }>('/api/dev/seed', { method: 'POST' });
    notifications.show({
      message: res.status === 'exists' ? 'Demo data already loaded' : 'Demo team created',
      color: 'green',
    });
    await qc.invalidateQueries();
  };

  return (
    <>
      <Menu position="bottom-end" withArrow width={280} closeOnItemClick>
        <Menu.Target>
          <Button
            size="compact-sm"
            variant="light"
            color="orange"
            leftSection={<IconFlask size={14} />}
          >
            <Text size="xs" truncate maw={140}>
              {me.data?.email ?? getDevUser() ?? 'dev'}
            </Text>
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Dev mode: act as…</Menu.Label>
          <ScrollArea.Autosize mah={260}>
            {users.data?.map((u) => (
              <Menu.Item
                key={u.id}
                leftSection={<IconUserCircle size={16} />}
                onClick={() => switchTo(u.email)}
                rightSection={
                  u.email === me.data?.email ? (
                    <Badge size="xs" variant="light">
                      you
                    </Badge>
                  ) : null
                }
              >
                <Text size="sm">{u.name}</Text>
                <Text size="xs" c="dimmed">
                  {u.email}
                </Text>
              </Menu.Item>
            ))}
          </ScrollArea.Autosize>
          <Menu.Divider />
          <Group p="xs" gap="xs" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
            <TextInput
              size="xs"
              placeholder="new.person@example.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && email && switchTo(email)}
              style={{ flex: 1 }}
            />
            <Button size="xs" disabled={!email} onClick={() => switchTo(email)}>
              Go
            </Button>
          </Group>
          <Menu.Divider />
          <Menu.Item leftSection={<IconSeeding size={16} />} onClick={seed}>
            Load demo data
          </Menu.Item>
          <Menu.Item leftSection={<IconMail size={16} />} onClick={outbox.open}>
            View sent emails
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={outboxOpen} onClose={outbox.close} title="Email outbox (dev)" size="lg">
        {outboxOpen && <Outbox />}
      </Modal>
    </>
  );
}

function Outbox() {
  const mails = useQuery({
    queryKey: ['dev', 'outbox'],
    queryFn: () => api<OutboxMail[]>('/api/dev/outbox'),
  });
  if (!mails.data?.length) {
    return (
      <Text c="dimmed" size="sm">
        No emails yet. Without SMTP configured, emails are captured here (and in the server log).
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      {mails.data.map((m, i) => (
        <Paper key={i} withBorder p="sm">
          <Text size="xs" c="dimmed">
            To {m.to}
          </Text>
          <Text fw={600} size="sm">
            {m.subject}
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {m.text}
          </Text>
          {m.link && (
            <Text size="xs" c="dimmed" mt={4}>
              {m.link}
            </Text>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
