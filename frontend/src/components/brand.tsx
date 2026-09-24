import { Stack, Text, Title } from '@mantine/core';
import { type ReactNode, useId } from 'react';

const TILE = 'M17 18H47A11 11 0 0 1 58 29V47A11 11 0 0 1 47 58H17A11 11 0 0 1 6 47V29A11 11 0 0 1 17 18Z';
const UPPER_JAW =
  'M0 0H64V29.4L56 29.4L52 35.4L48 29.4L44 35.4L40 29.4L36 35.4L32 29.4L28 35.4L24 29.4L20 35.4L16 29.4L12 35.4L8 29.4L0 29.4Z';
const LOWER_JAW =
  'M0 64H64V32.6L56 32.6L52 38.6L48 32.6L44 38.6L40 32.6L36 38.6L32 32.6L28 38.6L24 32.6L20 38.6L16 32.6L12 38.6L8 32.6L0 32.6Z';

/**
 * The AlloGator mark: a gator peeking out of a calendar tile, its eyes doubling as the binder
 * rings and its teeth as the zigzag between the jaws. Flat and single-colour (it follows the
 * primary colour). `chomping` works the jaws (used while we're busy), `sleepy` closes its eyes
 * and mouth (used for "nothing to do" states). Hovering the header logo snaps it shut.
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
  // useId() contains characters that aren't safe inside url(#...) references.
  const id = `croc${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const tile = `${id}-tile`;
  const eyes = `${id}-eyes`;
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
      fill="currentColor"
    >
      <defs>
        <clipPath id={tile}>
          <path d={TILE} />
        </clipPath>
        <mask id={eyes}>
          <rect width="64" height="64" fill="#fff" />
          {sleepy ? (
            <path
              d="M17.5 16.5Q21 19.5 24.5 16.5M39.5 16.5Q43 19.5 46.5 16.5"
              stroke="#000"
              strokeWidth="2.4"
              strokeLinecap="round"
              fill="none"
            />
          ) : (
            <>
              <circle cx="21" cy="15.5" r="4.2" fill="#000" />
              <circle cx="43" cy="15.5" r="4.2" fill="#000" />
            </>
          )}
        </mask>
      </defs>
      <g className="croc-upper">
        <g mask={`url(#${eyes})`}>
          <circle cx="21" cy="16" r="9" />
          <circle cx="43" cy="16" r="9" />
          <path d={UPPER_JAW} clipPath={`url(#${tile})`} />
        </g>
        {!sleepy && <path d="M21 12.4v6.2M43 12.4v6.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
      </g>
      <g className="croc-lower">
        <path d={LOWER_JAW} clipPath={`url(#${tile})`} />
      </g>
      {sleepy && (
        <g fill="var(--mantine-color-dimmed)" fontFamily="system-ui, sans-serif" fontWeight="700">
          <text x="52" y="11" fontSize="8">
            z
          </text>
          <text x="58" y="5" fontSize="6">
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
