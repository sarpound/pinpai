type Stay = { id: string; name: string; lat: number; lng: number; day_index: number | null; details?: { nights?: number } };

/** The hotel you wake up in / return to on day d: the latest check-in on or before d (else the first one). */
export function stayForDay<T extends Stay>(stays: T[], d: number): T | null {
  if (!stays.length) return null;
  const dated = stays.filter((s) => s.day_index != null).sort((a, b) => a.day_index! - b.day_index!);
  const before = dated.filter((s) => s.day_index! <= d);
  return before[before.length - 1] ?? dated[0] ?? stays[0];
}
