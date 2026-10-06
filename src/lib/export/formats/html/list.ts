/**
 * Arrays of an API message are attacker-controlled: anything that is not an array becomes empty, and entries that
 * are not objects are skipped, so renderers can read properties without guards.
 */
export function objectsOf<T extends object>(value: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter((item): item is T => typeof item === 'object' && item !== null);
}
