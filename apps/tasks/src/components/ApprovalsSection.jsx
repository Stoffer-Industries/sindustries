import { useEffect, useState } from 'react';
import { Avatar } from '@sindustries/ui/react';
import { fetchRequiredApprovals } from '../tasksApi.ts';
import { assigneeDisplayName, findAssigneeUser } from '../users/assignees.js';

const APPROVAL_LABELS = {
  spec: 'Spec',
  tech_design: 'Tech Design',
  qa: 'QA'
};

/**
 * Resolve the approval row for a given required type from the task's
 * `approvals` array. Returns `null` when no row exists (Pending).
 */
function findApprovalForType(approvals, type) {
  if (!Array.isArray(approvals)) return null;
  // Prefer the most recent state — `approved` wins over `revoked` if both
  // happen to exist (the migration script can produce both during a
  // re-run; the upsert keeps `state` as the latest value).
  return (
    approvals.find((approval) => approval.type === type && approval.state === 'approved') ??
    approvals.find((approval) => approval.type === type) ??
    null
  );
}

/**
 * Format a timestamp for the aria-label tooltip.
 */
function formatApprovalTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function approvalTooltip(approval, type) {
  const label = APPROVAL_LABELS[type];
  if (!approval) return `${label} pending`;
  const owner = assigneeDisplayName(approval.owner) || approval.owner;
  const timestamp = formatApprovalTimestamp(approval.approvedAt);
  if (approval.state === 'revoked') {
    return `${label} revoked by ${owner}${timestamp ? ` on ${timestamp}` : ''}`;
  }
  return `${label} approved by ${owner}${timestamp ? ` on ${timestamp}` : ''}`;
}

/**
 * Read-only Approvals section for the task editor.
 *
 * The view is intentionally checkbox + avatar only — no "Pending" or
 * "Approved by <name>" inline text. State is implied by the checkbox
 * (checked = approved) and the avatar's opacity / strike-through (a
 * revoked approval renders muted). Owner name + timestamp move to the
 * aria-label / hover tooltip so the visual is uncluttered.
 *
 * Writes flow through `POST /tasks/:id/approvals` (lobster / agent) or
 * the comment-based legacy path. The Tasks UI is read-only here.
 *
 * See docs/specs/tasks-api-native-approvals-tech-design.md WS4b.
 */
export function ApprovalsSection({ task }) {
  const taskType = task?.taskType ?? null;
  const [requiredApprovals, setRequiredApprovals] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!taskType) {
      setRequiredApprovals([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchRequiredApprovals(taskType)
      .then((response) => {
        if (cancelled) return;
        setRequiredApprovals(response.requiredApprovals);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load required approvals');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskType]);

  if (!taskType) {
    return (
      <div className="approvals-section" aria-label="Approvals">
        <div className="approvals-header">
          <h4 className="si-font-display">Approvals</h4>
        </div>
        <p className="small approvals-empty">Select a task type to view required approvals.</p>
      </div>
    );
  }

  return (
    <div className="approvals-section" aria-label="Approvals">
      <div className="approvals-header">
        <h4 className="si-font-display">Approvals</h4>
        {isLoading ? <span className="small">Loading…</span> : null}
        {error ? <span className="small approvals-error">{error}</span> : null}
      </div>
      {requiredApprovals.length === 0 ? (
        <p className="small approvals-empty">No approvals required for this task type.</p>
      ) : (
        <ul className="approvals-list" aria-label="Required approvals">
          {requiredApprovals.map((type) => {
            const approval = findApprovalForType(task.approvals, type);
            const owner = approval?.owner ?? null;
            const ownerUser = owner ? findAssigneeUser(owner) : null;
            const ownerLabel = owner ? assigneeDisplayName(owner) || owner : APPROVAL_LABELS[type];
            const avatarSrc = ownerUser?.avatarSrc ?? null;
            const state = approval?.state ?? 'pending';
            const isApproved = state === 'approved';
            const isRevoked = state === 'revoked';

            return (
              <li key={type} className="approvals-row" data-state={state}>
                <label
                  className="approvals-row-label"
                  title={approvalTooltip(approval, type)}
                  aria-label={approvalTooltip(approval, type)}
                >
                  <input
                    type="checkbox"
                    checked={isApproved}
                    disabled
                    readOnly
                    aria-label={`${APPROVAL_LABELS[type]} approval state`}
                  />
                  <Avatar
                    size="sm"
                    src={avatarSrc}
                    alt={ownerLabel}
                    aria-label={ownerLabel}
                    className={`approvals-avatar${isApproved ? ' is-approved' : ''}${isRevoked ? ' is-revoked' : ' is-pending'}`}
                  />
                  <span className="approvals-row-type">{APPROVAL_LABELS[type]}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
