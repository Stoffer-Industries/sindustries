/**
 * Pure helpers extracted from `dedupe-attention-owners.ts` so the script's
 * repair logic can be unit-tested without spawning a tsx subprocess or
 * hitting the database.
 *
 * The script itself remains the entry point and the sole consumer of
 * `prisma`; the helpers below stay side-effect-free so the test file can
 * exercise the collapse plan, snapshot format, and rollback restore path
 * deterministically.
 */

export type RowSnapshot = {
  id: string;
  taskId: string;
  owner: string;
  addedBy: string | null;
  note: string | null;
  position: number;
  createdAt: string;
};

export type TaskSnapshot = {
  taskId: string;
  rows: RowSnapshot[];
  collapsed: string[];
};

/**
 * Group pre-existing `TaskAttentionOwner` rows by task and return the
 * tasks whose stack has at least one case-insensitive duplicate. Pure
 * function over the supplied fixture; the script calls into prisma to
 * build the input.
 */
export function selectTasksWithDuplicates<Row extends { taskId: string; owner: string; position: number }>(
  rows: Row[]
): Array<{ taskId: string; rows: Row[] }> {
  const byTask = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byTask.get(row.taskId) ?? [];
    list.push(row);
    byTask.set(row.taskId, list);
  }
  const out: Array<{ taskId: string; rows: Row[] }> = [];
  for (const [taskId, list] of byTask.entries()) {
    const seen = new Set<string>();
    let hasDup = false;
    for (const r of list) {
      const key = r.owner.trim().toLowerCase();
      if (seen.has(key)) {
        hasDup = true;
        break;
      }
      seen.add(key);
    }
    if (hasDup) out.push({ taskId, rows: list });
  }
  return out;
}

/**
 * Split a pre-state snapshot into `kept` (first occurrence wins per
 * case-insensitive owner) and `dropped` (subsequent duplicates). Order
 * matches the input so position-preservation logic downstream can rely
 * on the original index.
 */
export function collapsePlan<Row extends { id: string; owner: string; position: number }>(
  rows: Row[]
): { kept: Row[]; dropped: Row[] } {
  const kept: Row[] = [];
  const dropped: Row[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.owner.trim().toLowerCase();
    if (seen.has(key)) {
      dropped.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, dropped };
}

/**
 * Build the durable snapshot shape the `--write` mode persists and
 * `--rollback` reads. The script round-trips the JSON via
 * `writeFileSync` / `readFileSync`; this helper keeps the schema in one
 * place so the test can assert on it.
 */
export function buildTaskSnapshot<Row extends RowSnapshot>(
  taskId: string,
  rows: Row[],
  collapsed: string[]
): TaskSnapshot {
  return {
    taskId,
    rows: rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      owner: r.owner,
      addedBy: r.addedBy,
      note: r.note,
      position: r.position,
      createdAt: r.createdAt
    })),
    collapsed
  };
}

/**
 * Renumber a kept set so positions are contiguous starting at 0, in
 * the same order they were kept. Pure function; the script wraps the
 * resulting plan in a `prisma.$transaction`.
 */
export function renumberPlan<Row extends { id: string }>(
  kept: Row[]
): Array<{ id: string; position: number }> {
  return kept.map((row, idx) => ({ id: row.id, position: idx }));
}

/**
 * Build the audit comment body for a dropped duplicate, preserving the
 * kept row's note when one was supplied. The script emits one
 * `TaskComment` per dropped owner so the audit trail records exactly
 * which duplicates the repair run collapsed.
 */
export function duplicateAuditBody(droppedOwner: string, preservedNote: string | null): string {
  const noteSuffix = preservedNote ? ` preserved note: "${preservedNote}"` : '';
  return `Duplicate attention owner "${droppedOwner}" (case-insensitive) collapsed by repair script;${noteSuffix}`;
}