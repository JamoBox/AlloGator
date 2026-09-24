import {
  ActionIcon,
  AppShell,
  Avatar,
  Burger,
  Divider,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Text,
  Title,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCalendarOff,
  IconHome,
  IconLogout,
  IconMoon,
  IconSettings,
  IconShieldLock,
  IconSun,
  IconUsersGroup,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useConfig, useMe, usePrefetch } from '../api/hooks';
import { initials, personColor } from '../lib/people';
import { CrocLogo } from './brand';
import { DevUserSwitcher } from './DevUserSwitcher';
import { NotificationsMenu } from './NotificationsMenu';

export function Layout({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure();
  const me = useMe();
  const config = useConfig();
  const location = useLocation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const prefetch = usePrefetch();

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <UnstyledButton component={Link} to="/" onClick={close} className="ag-logo" aria-label="AlloGator home">
              <Group gap={6} wrap="nowrap">
                <CrocLogo size={38} title="" />
                <div>
                  <Title order={3} c="gator.8" lh={1}>
                    AlloGator
                  </Title>
                  <Text size="10px" c="dimmed" lh={1.2} visibleFrom="xs">
                    snappy on-call allocation
                  </Text>
                </div>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {config.data?.auth_mode === 'dev' && <DevUserSwitcher />}
            {me.data && <NotificationsMenu />}
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={toggleColorScheme}
              aria-label="Toggle colour scheme"
            >
              {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
            {me.data && (
              <Menu position="bottom-end" withArrow>
                <Menu.Target>
                  <UnstyledButton aria-label="Account menu">
                    <Avatar color={personColor(me.data.id)} radius="xl" size={32}>
                      {initials(me.data.name)}
                    </Avatar>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>
                    {me.data.name}
                    <br />
                    {me.data.email}
                  </Menu.Label>
                  <Menu.Item component={Link} to="/profile" leftSection={<IconSettings size={16} />}>
                    Profile & calendar
                  </Menu.Item>
                  {config.data?.logout_url && (
                    <Menu.Item
                      component="a"
                      href={config.data.logout_url}
                      leftSection={<IconLogout size={16} />}
                    >
                      Sign out
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          <NavLink
            component={Link}
            to="/"
            label="My on-call"
            leftSection={<IconHome size={18} />}
            active={isActive('/')}
            onClick={close}
          />
          <NavLink
            component={Link}
            to="/availability"
            label="My availability"
            leftSection={<IconCalendarOff size={18} />}
            active={isActive('/availability')}
            onClick={close}
          />
          <NavLink
            component={Link}
            to="/teams"
            label="Teams"
            leftSection={<IconUsersGroup size={18} />}
            active={location.pathname === '/teams'}
            onClick={close}
          />
          {me.data && me.data.memberships.length > 0 && (
            <>
              <Divider my="xs" label="My teams" labelPosition="left" />
              {me.data.memberships.map((m) => (
                <NavLink
                  key={m.team_id}
                  component={Link}
                  to={`/teams/${m.team_id}`}
                  label={m.team_name}
                  description={m.role === 'leader' ? 'Leader' : undefined}
                  active={location.pathname.startsWith(`/teams/${m.team_id}`)}
                  onClick={close}
                  onMouseEnter={() => prefetch.team(m.team_id)}
                />
              ))}
            </>
          )}
        </AppShell.Section>
        {me.data?.is_admin && (
          <AppShell.Section>
            <Divider my="xs" />
            <NavLink
              component={Link}
              to="/admin"
              label="Admin"
              leftSection={<IconShieldLock size={18} />}
              active={isActive('/admin')}
              onClick={close}
            />
          </AppShell.Section>
        )}
        {config.data && (
          <Text size="xs" c="dimmed" ta="center" mt="xs">
            AlloGator v{config.data.version}
          </Text>
        )}
      </AppShell.Navbar>

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
