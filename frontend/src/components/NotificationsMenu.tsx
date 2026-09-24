import {
  ActionIcon,
  Button,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { IconBell } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { keys, useAction, useNotifications, useUnreadCount } from '../api/hooks';
import type { Notification } from '../api/types';
import { fromNow } from '../lib/dates';

export function NotificationsMenu() {
  const [opened, setOpened] = useState(false);
  const unread = useUnreadCount();
  const list = useNotifications();
  const navigate = useNavigate();
  const markRead = useAction((ids: number[] | null) => api('/api/notifications/read', { body: { ids } }), {
    optimistic: (ids, qc) => {
      const prevList = qc.getQueryData<Notification[]>(keys.notifications);
      const prevCount = qc.getQueryData<{ count: number }>(keys.unread);
      const now = new Date().toISOString();
      if (prevList)
        qc.setQueryData(
          keys.notifications,
          prevList.map((n) => (!n.read_at && (ids === null || ids.includes(n.id)) ? { ...n, read_at: now } : n)),
        );
      if (prevCount)
        qc.setQueryData(keys.unread, { count: ids === null ? 0 : Math.max(0, prevCount.count - ids.length) });
      return () => {
        qc.setQueryData(keys.notifications, prevList);
        qc.setQueryData(keys.unread, prevCount);
      };
    },
    invalidate: [keys.notifications],
  });

  const open = (n: Notification) => {
    if (!n.read_at) markRead.mutate([n.id]);
    setOpened(false);
    if (n.link) navigate(n.link);
  };

  const count = unread.data?.count ?? 0;
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={360}
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <Indicator label={count} size={16} disabled={count === 0} offset={4} color="red">
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={() => setOpened((o) => !o)}
            aria-label="Notifications"
          >
            <IconBell size={20} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" p="sm" pb={4}>
          <Text fw={600}>Notifications</Text>
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={count === 0}
            onClick={() => markRead.mutate(null)}
          >
            Mark all read
          </Button>
        </Group>
        <ScrollArea.Autosize mah={420}>
          <Stack gap={0}>
            {list.data?.length === 0 && (
              <Text c="dimmed" size="sm" p="sm">
                Nothing yet.
              </Text>
            )}
            {list.data?.map((n) => (
              <UnstyledButton
                key={n.id}
                onClick={() => open(n)}
                p="sm"
                style={{
                  borderTop: '1px solid var(--mantine-color-default-border)',
                  background: n.read_at ? undefined : 'var(--mantine-primary-color-light)',
                }}
              >
                <Text size="sm" fw={n.read_at ? 400 : 600} lineClamp={2}>
                  {n.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {fromNow(n.created_at)}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
