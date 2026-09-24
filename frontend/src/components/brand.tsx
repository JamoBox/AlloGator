import { Stack, Text, Title } from '@mantine/core';
import { type ReactNode, useId } from 'react';

const TILE =
  'M16 20H48A10 10 0 0 1 58 30V44A10 10 0 0 1 48 54H16A10 10 0 0 1 6 44V30A10 10 0 0 1 16 20Z';
const UPPER_JAW =
  'M0 0H64V38.7L52 38.7L48 42.2L44 38.7L40 42.2L36 38.7L32 42.2L28 38.7L24 42.2L20 38.7L16 42.2L12 38.7L0 38.7Z';
const LOWER_JAW =
  'M0 64H64V41.3L52 41.3L48 44.8L44 41.3L40 44.8L36 41.3L32 44.8L28 41.3L24 44.8L20 41.3L16 44.8L12 41.3L0 41.3Z';

/**
 * The AlloGator mark: a gator peeking out of a calendar tile, its eyes doubling as the binder
 * rings and its teeth as the zigzag between the jaws, with a pair of nostrils on its snout. Flat
 * and single-colour (it follows the primary colour). `chomping` works the jaws (used while we're busy), `sleepy` closes its eyes
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
              d="M17.5 17.5Q21 20.5 24.5 17.5M39.5 17.5Q43 20.5 46.5 17.5"
              stroke="#000"
              strokeWidth="2.4"
              strokeLinecap="round"
              fill="none"
            />
          ) : (
            <>
              <circle cx="21" cy="17.5" r="4" fill="#000" />
              <circle cx="43" cy="17.5" r="4" fill="#000" />
            </>
          )}
          <ellipse cx="28" cy="31" rx="1.4" ry="2.3" transform="rotate(-25 28 31)" fill="#000" />
          <ellipse cx="36" cy="31" rx="1.4" ry="2.3" transform="rotate(25 36 31)" fill="#000" />
        </mask>
      </defs>
      <g className="croc-upper">
        <g mask={`url(#${eyes})`}>
          <circle cx="21" cy="18" r="8.5" />
          <circle cx="43" cy="18" r="8.5" />
          <path d={UPPER_JAW} clipPath={`url(#${tile})`} />
        </g>
        {!sleepy && (
          <path
            d="M21 14.5v6M43 14.5v6"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
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
