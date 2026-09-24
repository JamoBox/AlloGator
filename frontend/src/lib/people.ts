// Stable colours per person so the same person looks the same everywhere.
// Red/orange are reserved for problems (uncovered, conflicts, limited availability).
const PALETTE = [
  'blue',
  'grape',
  'teal',
  'indigo',
  'cyan',
  'pink',
  'lime',
  'violet',
  'green',
  'yellow',
] as const;

export function personColor(userId: number | null | undefined): string {
  if (userId == null) return 'gray';
  return PALETTE[userId % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
