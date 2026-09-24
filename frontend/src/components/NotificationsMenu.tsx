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
import { IconBell, IconCheck } from '@tabler/icons-react';
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
      if (prevList)
        qc.setQueryData(
          keys.notifications,
          ids === null ? [] : prevList.filter((n) => !ids.includes(n.id)),
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

  // Opening a notification keeps the list open and leaves it unread: acknowledging is explicit.
  const open = (n: Notification) => {
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
            Acknowledge all
          </Button>
        </Group>
        <ScrollArea.Autosize mah={420}>
          <Stack gap={0}>
            {list.data?.length === 0 && (
              <Text c="dimmed" size="sm" p="sm">
                You're all caught up.
              </Text>
            )}
            {list.data?.map((n) => (
              <Group
                key={n.id}
                gap="xs"
                wrap="nowrap"
                align="flex-start"
                p="sm"
                style={{
                  borderTop: '1px solid var(--mantine-color-default-border)',
                  background: n.read_at ? undefined : 'var(--mantine-primary-color-light)',
                }}
              >
                <UnstyledButton onClick={() => open(n)} style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={n.read_at ? 400 : 600} lineClamp={2}>
                    {n.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {fromNow(n.created_at)}
                  </Text>
                </UnstyledButton>
                {!n.read_at && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconCheck size={12} />}
                    onClick={() => markRead.mutate([n.id])}
                  >
                    Acknowledge
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
