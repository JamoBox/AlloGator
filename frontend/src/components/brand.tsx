import { Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * The AlloGator croc. `chomping` animates the jaws (used while we're busy), `sleepy` closes
 * its eye and mouth (used for "nothing to do" states). Hovering the header logo snaps it shut.
 */
export function CrocLogo({
  size = 40,
  chomping = false,
  sleepy = false,
  title = 'AlloGator',
}: {
  size?: number;
  chomping?: boolean;
  sleepy?: boolean;
  title?: string;
}) {
  return (
    <svg
      className="croc"
      data-chomping={chomping || undefined}
      data-sleepy={sleepy || undefined}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
    >
      <path d="M15 39.2 L57 30.8 Q 51.5 37.4 54.6 43.8 L15 42.4 Z" fill="#7b2d3b" className="croc-mouth" />
      <g className="croc-lower">
        <path
          d="M11 43.4 C 13 42.2, 16 42, 18 42.2 L55 43.4 C 59.5 43.6, 60 46.4, 56.5 47.2 C 48 49.4, 38 50.8, 28 50.6 C 20 50.4, 14 48.6, 11 43.4 Z"
          fill="#2f9e44"
        />
        <path
          d="M17 48.2 C 26 50.2, 40 49.6, 55 46.4"
          stroke="#8ce99a"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
          opacity=".9"
        />
        <path
          d="M25.9 42.8 L29.1 42.9 L27.5 39.5 Z M32.9 43.1 L36.1 43.2 L34.5 39.7 Z M39.9 43.3 L43.1 43.4 L41.5 40.0 Z M46.4 43.6 L49.6 43.7 L48.0 40.2 Z"
          fill="#fff"
        />
      </g>
      <g className="croc-upper">
        <path
          d="M6.2 44 C 3.4 36, 4.6 27.5, 10 22.8 C 12.4 20.6, 15.6 19.6, 18.6 19.4 C 19.6 13.2, 25.4 9.8, 30.4 11.8 C 33.4 13, 35.2 15.8, 35.6 18.6 C 42.4 19.8, 50 21.4, 55.2 22.6 C 57.8 20.8, 60.8 22.2, 60.6 25 C 62.2 27, 61 30.4, 57.8 30.6 L18.6 37.6 C 15.4 38.3, 13.4 40.4, 12.6 44 Z"
          fill="#40c057"
        />
        <path
          d="M22.3 36.5 L25.7 35.9 L24.0 39.9 Z M29.3 35.3 L32.7 34.7 L31.0 38.7 Z M36.3 34.0 L39.7 33.4 L38.0 37.4 Z M43.3 32.8 L46.7 32.1 L45.0 36.2 Z M49.8 31.6 L53.2 31.0 L51.5 35.0 Z"
          fill="#fff"
        />
        <g fill="#2f9e44">
          <circle cx="9.2" cy="30" r="1.7" />
          <circle cx="11.6" cy="25.4" r="1.7" />
          <circle cx="15.6" cy="22" r="1.6" />
          <circle cx="42" cy="22.2" r="1" />
          <circle cx="47" cy="23.2" r="1" />
          <circle cx="44.5" cy="26" r="0.9" />
        </g>
        <ellipse cx="57.2" cy="24" rx="1.1" ry=".8" fill="#1b4d2a" />
        {sleepy ? (
          <path
            d="M22.6 16.4 C 24.6 19.2, 29.4 19.2, 31.4 16.4"
            stroke="#1c1c1c"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        ) : (
          <>
            <circle cx="27" cy="16.4" r="5.4" fill="#fff" />
            <circle cx="28.4" cy="16.6" r="2.9" fill="#1c1c1c" className="croc-pupil" />
            <circle cx="29.4" cy="15.4" r="1" fill="#fff" />
          </>
        )}
        <path
          d="M21.2 13.6 C 23.6 10.6, 29.4 10, 32.6 13.2"
          stroke="#2f9e44"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </g>
      {sleepy && (
        <g fill="var(--mantine-color-dimmed)" fontFamily="system-ui, sans-serif" fontWeight="700">
          <text x="40" y="12" fontSize="8">
            z
          </text>
          <text x="48" y="7" fontSize="6">
            z
          </text>
        </g>
      )}
    </svg>
  );
}

/** A small line icon of open jaws, in the same style as Tabler icons. */
export function IconChomp({ size = 16, stroke = 2 }: { size?: number; stroke?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 14c-.5-5 2.5-8.2 7-8.5c3.5-.2 7 .7 9.8 1.8c1 .5.8 1.9-.3 2.1L7.5 12.4c-1.5.4-2.5.9-3.5 1.6z" />
      <path d="M10 11.8l.9 1.8l.9-2.3M14 10.9l.9 1.8l.9-2.3" />
      <path d="M4.5 15.6l14.5 1.7c1.2.2 1.3 1.6.2 2c-5.2 1.8-10.7 1.6-13.7-.7c-.7-.7-1-1.9-1-3z" />
      <path d="M11 16.4l.9-1.8l.9 2" />
      <path d="M10.5 8.6h.01" />
    </svg>
  );
}

export function ChompLoader({ label = 'Chomping…', size = 64 }: { label?: string; size?: number }) {
  return (
    <Stack align="center" gap={4} py="xl" role="status" aria-live="polite">
      <CrocLogo size={size} chomping title="Loading" />
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

export function CrocEmpty({
  title,
  description,
  sleepy = false,
  children,
  size = 88,
}: {
  title: ReactNode;
  description?: ReactNode;
  sleepy?: boolean;
  children?: ReactNode;
  size?: number;
}) {
  return (
    <Stack align="center" gap={6} py="lg" ta="center">
      <CrocLogo size={size} sleepy={sleepy} title="" />
      <Title order={4}>{title}</Title>
      {description && (
        <Text c="dimmed" size="sm" maw={420}>
          {description}
        </Text>
      )}
      {children}
    </Stack>
  );
}
