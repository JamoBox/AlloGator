import {
  Avatar,
  Badge,
  Button,
  CopyButton,
  Group,
  Menu,
  NumberInput,
  type NumberInputProps,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCalendarDown,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconLink,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { download } from '../api/client';
import type { RotaStatus, User } from '../api/types';
import { initials, personColor } from '../lib/people';

export function PersonChip({
  user,
  size = 'sm',
  muted,
}: {
  user: Pick<User, 'id' | 'name'> | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  muted?: boolean;
}) {
  if (!user) {
    return (
      <Badge color="red" variant="filled" size={size}>
        Nobody
      </Badge>
    );
  }
  return (
    <Group gap={6} wrap="nowrap">
      <Avatar size={size === 'xs' ? 18 : size === 'sm' ? 22 : 28} radius="xl" color={personColor(user.id)}>
        <Text fz={size === 'md' ? 11 : 9} fw={700}>
          {initials(user.name)}
        </Text>
      </Avatar>
      <Text size={size} c={muted ? 'dimmed' : undefined} truncate>
        {user.name}
      </Text>
    </Group>
  );
}

const STATUS: Record<RotaStatus, { label: string; color: string; hint: string }> = {
  planning: { label: 'Planning', color: 'gray', hint: 'Being set up by a leader' },
  collecting: { label: 'Collecting dates', color: 'blue', hint: 'Waiting for availability' },
  review: { label: 'Draft', color: 'orange', hint: 'Schedule generated, being reviewed' },
  published: { label: 'Published', color: 'gator', hint: 'Final schedule' },
};

export function RotaStatusBadge({ status }: { status: RotaStatus }) {
  const s = STATUS[status];
  return (
    <Tooltip label={s.hint} withArrow>
      <Badge color={s.color} variant="light">
        {s.label}
      </Badge>
    </Tooltip>
  );
}

export function downloadOrToast(path: string, name: string) {
  download(path, name).catch((e: Error) =>
    notifications.show({ title: 'Download failed', message: e.message, color: 'red' }),
  );
}

/** "Add to calendar" menu: download .ics now, or subscribe to the live feed. */
export function CalendarButton({
  query = '',
  feedUrl,
  label = 'Add to calendar',
  variant = 'light',
}: {
  query?: string;
  feedUrl?: string;
  label?: string;
  variant?: 'light' | 'filled' | 'default' | 'subtle';
}) {
  return (
    <Menu position="bottom-end" withArrow width={340}>
      <Menu.Target>
        <Button
          variant={variant}
          leftSection={<IconCalendarDown size={16} />}
          rightSection={<IconChevronDown size={14} />}
        >
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconCalendarDown size={16} />}
          onClick={() => downloadOrToast(`/api/me/calendar.ics${query}`, 'my-on-call.ics')}
        >
          Download .ics file
          <Text size="xs" c="dimmed">
            A snapshot of your shifts to import into any calendar
          </Text>
        </Menu.Item>
        {feedUrl && (
          <>
            <Menu.Divider />
            <Stack gap={4} p="xs">
              <Group gap={6}>
                <IconLink size={16} />
                <Text size="sm">Subscribe (stays up to date after swaps)</Text>
              </Group>
              <FeedUrl url={feedUrl} />
            </Stack>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

export function FeedUrl({ url }: { url: string }) {
  return (
    <Group gap={4} wrap="nowrap">
      <TextInput size="xs" value={url} readOnly style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
      <CopyButton value={url}>
        {({ copied, copy }) => (
          <Button size="xs" variant={copied ? 'filled' : 'light'} onClick={copy} px={8}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <Group justify="space-between" mb="xs" wrap="nowrap">
      <Text fw={700} size="lg">
        {children}
      </Text>
      {right}
    </Group>
  );
}

/**
 * A whole-number input that can be cleared while typing (so "8, backspace, 7" gives 7, not
 * 71). ``onChange`` only fires with valid numbers; leaving it empty restores the last value.
 */
export function WholeNumberInput({
  value,
  onChange,
  onBlur,
  min,
  ...props
}: Omit<NumberInputProps, 'value' | 'onChange'> & { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState<number | string>(value);
  useEffect(() => {
    setText((t) => (t === '' || Number(t) !== value ? value : t));
  }, [value]);
  return (
    <NumberInput
      {...props}
      min={min}
      allowDecimal={false}
      value={text}
      onChange={(v) => {
        setText(v);
        if (typeof v === 'number' && (min === undefined || v >= min)) onChange(v);
      }}
      onBlur={(e) => {
        if (typeof text !== 'number' || (min !== undefined && text < min)) setText(value);
        onBlur?.(e);
      }}
    />
  );
}
