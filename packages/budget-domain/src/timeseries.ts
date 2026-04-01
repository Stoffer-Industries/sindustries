export type TimeseriesBucket = { day: string; amountCents: number };

export function bucketByDay(items: { occurredAt: Date; amountCents: number }[]) {
  const buckets = new Map<string, number>();
  for (const it of items) {
    const day = it.occurredAt.toISOString().slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + it.amountCents);
  }
  return [...buckets.entries()]
    .map(([day, amountCents]) => ({ day, amountCents }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

