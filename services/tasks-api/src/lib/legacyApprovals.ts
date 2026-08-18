// Detection logic for legacy approval state embedded in task descriptions
// and comment bodies. Extracted from `scripts/migrate-legacy-approvals.ts`
// so the rules can be unit-tested without spinning up the migration script.
//
// See docs/specs/tasks-api-native-approvals-tech-design.md WS4a.

const SPEC_DESCRIPTION_PATTERN = /^\s*-\s*\[x\]\s+\*\*Approved by Tom\*\*\s*$/m;
const SPEC_DESCRIPTION_NEGATIVE_PATTERN = /^\s*-\s*\[ \]\s+\*\*Approved by Tom\*\*\s*$/m;
const TECH_DESIGN_COMMENT_PATTERN = /\[tech-design-approved\]\s+true/;
const QA_COMMENT_PATTERN = /\[qa-ac-verified\]\s+true/;

export type ApprovalType = 'spec' | 'tech_design' | 'accepted';

export interface DetectedApproval {
  type: ApprovalType;
  owner: string;
  note: string;
}

export interface TaskLikeForMigration {
  id: string;
  description: string | null;
  approvals: Array<{ type: ApprovalType }>;
  comments: Array<{ author: string; text: string }>;
}

export function detectLegacyApprovals(task: TaskLikeForMigration): DetectedApproval[] {
  const out: DetectedApproval[] = [];
  const description = task.description ?? '';

  if (SPEC_DESCRIPTION_PATTERN.test(description)) {
    out.push({
      type: 'spec',
      owner: 'Tom',
      note: 'Migrated from `**Approved by Tom**` in task description.'
    });
  } else if (SPEC_DESCRIPTION_NEGATIVE_PATTERN.test(description)) {
    // Explicit unchecked — intentionally not migrated.
  }

  for (const comment of task.comments) {
    if (TECH_DESIGN_COMMENT_PATTERN.test(comment.text)) {
      out.push({
        type: 'tech_design',
        owner: comment.author,
        note: 'Migrated from `[tech-design-approved] true` comment.'
      });
    }
    if (QA_COMMENT_PATTERN.test(comment.text)) {
      out.push({
        type: 'accepted',
        owner: comment.author,
        note: 'Migrated from `[qa-ac-verified] true` comment.'
      });
    }
  }

  return out;
}

export function existingApprovalKeys(task: TaskLikeForMigration): Set<string> {
  return new Set(task.approvals.map((a) => `${task.id}:${a.type}`));
}

export interface MigrationBreakdown {
  type: ApprovalType;
  created: number;
  skippedExisting: number;
}

export interface MigrationSummary {
  totalTasks: number;
  createdApprovals: number;
  skippedExisting: number;
  breakdownByType: MigrationBreakdown[];
}

export function summarizeMigration(
  tasks: TaskLikeForMigration[]
): MigrationSummary {
  const breakdownByType: MigrationBreakdown[] = [];
  let createdApprovals = 0;
  let skippedExisting = 0;

  for (const task of tasks) {
    const detected = detectLegacyApprovals(task);
    const existing = existingApprovalKeys(task);
    for (const approval of detected) {
      const key = `${task.id}:${approval.type}`;
      let bucket = breakdownByType.find((b) => b.type === approval.type);
      if (!bucket) {
        bucket = { type: approval.type, created: 0, skippedExisting: 0 };
        breakdownByType.push(bucket);
      }
      if (existing.has(key)) {
        bucket.skippedExisting += 1;
        skippedExisting += 1;
      } else {
        bucket.created += 1;
        createdApprovals += 1;
      }
    }
  }

  return {
    totalTasks: tasks.length,
    createdApprovals,
    skippedExisting,
    breakdownByType
  };
}
