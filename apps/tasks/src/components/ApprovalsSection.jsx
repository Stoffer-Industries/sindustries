import { useEffect, useState } from 'react';
import { Avatar } from '@sindustries/ui/react';
import {
  createTaskApproval,
  deleteTaskApproval,
  fetchAuthSession,
  fetchRequiredApprovals,
  login,
  logout
} from '../tasksApi.ts';
import { assigneeDisplayName, findAssigneeUser } from '../users/assignees.js';

const APPROVAL_LABELS = {
  spec: 'Spec',
  tech_design: 'Tech Design',
  qa_agent: 'QA (Ash)',
  accepted: 'Accepted'
};

function findApprovalForType(approvals, type) {
  if (!Array.isArray(approvals)) return null;
  return (
    approvals.find((approval) => approval.type === type && approval.state === 'approved') ??
    approvals.find((approval) => approval.type === type) ??
    null
  );
}

function replaceApproval(approvals, type, approval) {
  const next = (Array.isArray(approvals) ? approvals : []).filter((entry) => entry.type !== type);
  return approval ? [...next, approval] : next;
}

function formatApprovalTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function approvalTooltip(approval, type, isPending) {
  const label = APPROVAL_LABELS[type];
  if (isPending) return `${label} approval updating`;
  if (!approval) return `${label} pending`;
  const owner = assigneeDisplayName(approval.owner) || approval.owner;
  const timestamp = formatApprovalTimestamp(approval.approvedAt);
  if (approval.state === 'revoked') {
    return `${label} revoked by ${owner}${timestamp ? ` on ${timestamp}` : ''}`;
  }
  return `${label} approved by ${owner}${timestamp ? ` on ${timestamp}` : ''}`;
}

/** Interactive, authenticated approval controls for the task editor. */
export function ApprovalsSection({ task, onTaskRefresh }) {
  const taskType = task?.taskType ?? null;
  const [requiredApprovals, setRequiredApprovals] = useState([]);
  const [approvals, setApprovals] = useState(task?.approvals ?? []);
  const [pendingTypes, setPendingTypes] = useState(() => new Set());
  const [rowErrors, setRowErrors] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [actor, setActor] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');
  const [loginForType, setLoginForType] = useState(null);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((currentActor) => {
        if (!cancelled) {
          setActor(currentActor);
          setAuthStatus('authenticated');
        }
      })
      .catch(() => {
        if (!cancelled) setAuthStatus('anonymous');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setApprovals(task?.approvals ?? []);
  }, [task?.approvals]);

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
        if (!cancelled) setRequiredApprovals(response.requiredApprovals);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load required approvals');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [taskType]);

  function requestToggle(type) {
    if (authStatus !== 'authenticated') {
      setLoginForType(type);
      setAuthError(null);
      return;
    }
    void toggleApproval(type);
  }

  async function handleLogin(event) {
    event.preventDefault();
    const requestedType = loginForType;
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      const currentActor = await login(credentials);
      setActor(currentActor);
      setAuthStatus('authenticated');
      setCredentials({ username: '', password: '' });
      setLoginForType(null);
      if (requestedType) await toggleApproval(requestedType);
    } catch (err) {
      setCredentials((current) => ({ ...current, password: '' }));
      setAuthError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function handleLogout() {
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      await logout();
      setActor(null);
      setAuthStatus('anonymous');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      setIsAuthenticating(false);
    }
  }

  async function toggleApproval(type) {
    const snapshot = findApprovalForType(approvals, type);
    const wasApproved = snapshot?.state === 'approved';
    const optimistic = wasApproved
      ? { ...snapshot, state: 'revoked', revokedAt: new Date().toISOString() }
      : {
          ...(snapshot ?? {}),
          id: snapshot?.id ?? `optimistic-${type}`,
          type,
          owner: snapshot?.owner ?? '',
          state: 'approved',
          approvedAt: new Date().toISOString(),
          revokedAt: null
        };

    setRowErrors((current) => ({ ...current, [type]: null }));
    setPendingTypes((current) => new Set(current).add(type));
    setApprovals((current) => replaceApproval(current, type, optimistic));

    try {
      const result = wasApproved
        ? await deleteTaskApproval(task.id, type)
        : await createTaskApproval(task.id, { type });
      setApprovals((current) => replaceApproval(current, type, result));
      if (onTaskRefresh) {
        try {
          await onTaskRefresh(task.id);
        } catch {
          setRowErrors((current) => ({
            ...current,
            [type]: 'Approval updated, but the task could not be refreshed.'
          }));
        }
      }
    } catch (err) {
      setApprovals((current) => replaceApproval(current, type, snapshot));
      setRowErrors((current) => ({
        ...current,
        [type]: err instanceof Error ? err.message : `Failed to update ${APPROVAL_LABELS[type]} approval`
      }));
    } finally {
      setPendingTypes((current) => {
        const next = new Set(current);
        next.delete(type);
        return next;
      });
    }
  }

  if (!taskType) {
    return (
      <div className="approvals-section" aria-label="Approvals">
        <div className="approvals-header"><h4 className="si-font-display">Approvals</h4></div>
        <p className="small approvals-empty">Select a task type to view required approvals.</p>
      </div>
    );
  }

  const isImmutable = Boolean(task?.archivedAt) || task?.status === 'done';

  return (
    <div className="approvals-section" aria-label="Approvals">
      <div className="approvals-header">
        <h4 className="si-font-display">Approvals</h4>
        {isLoading ? <span className="small">Loading…</span> : null}
        {authStatus === 'authenticated' ? (
          <span className="approvals-session small">
            Signed in as {actor?.displayName || actor?.actor || actor?.username}
            <button type="button" className="approvals-session-action" onClick={() => void handleLogout()} disabled={isAuthenticating}>Log out</button>
          </span>
        ) : authStatus === 'anonymous' ? <span className="small">Sign in to change approvals</span> : null}
        {error ? <span className="small approvals-error" role="alert">{error}</span> : null}
      </div>
      {loginForType ? (
        <form className="approvals-login" aria-label="Sign in to update approvals" onSubmit={handleLogin}>
          <label>
            <span className="small">Username</span>
            <input
              name="username"
              autoComplete="username"
              required
              value={credentials.username}
              onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
            />
          </label>
          <label>
            <span className="small">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={credentials.password}
              onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
            />
          </label>
          <div className="approvals-login-actions">
            <button type="submit" disabled={isAuthenticating}>Sign in</button>
            <button type="button" disabled={isAuthenticating} onClick={() => { setLoginForType(null); setCredentials({ username: '', password: '' }); setAuthError(null); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {authError ? <p className="small approvals-error" role="alert">{authError}</p> : null}
      {requiredApprovals.length === 0 ? (
        <p className="small approvals-empty">No approvals required for this task type.</p>
      ) : (
        <ul className="approvals-list" aria-label="Required approvals">
          {requiredApprovals.map((type) => {
            const approval = findApprovalForType(approvals, type);
            const owner = approval?.owner || null;
            const ownerUser = owner ? findAssigneeUser(owner) : null;
            const ownerLabel = owner ? assigneeDisplayName(owner) || owner : APPROVAL_LABELS[type];
            const state = approval?.state ?? 'pending';
            const isApproved = state === 'approved';
            const isRevoked = state === 'revoked';
            const isPending = pendingTypes.has(type);
            const isAuthorized = authStatus !== 'authenticated' || actor?.approvalTypes?.includes(type);
            const tooltip = authStatus === 'authenticated' && !isAuthorized
              ? `${APPROVAL_LABELS[type]} approval requires an authorized actor`
              : approvalTooltip(approval, type, isPending);

            return (
              <li key={type} className="approvals-row" data-state={state}>
                <label className="approvals-row-label" title={tooltip} aria-label={tooltip}>
                  <input
                    type="checkbox"
                    checked={isApproved}
                    disabled={isImmutable || isPending || authStatus === 'loading' || !isAuthorized}
                    onChange={() => requestToggle(type)}
                    aria-label={`${APPROVAL_LABELS[type]} approval`}
                    aria-describedby={rowErrors[type] ? `approval-error-${type}` : undefined}
                  />
                  <Avatar
                    size="sm"
                    src={ownerUser?.avatarSrc ?? null}
                    alt={ownerLabel}
                    aria-label={ownerLabel}
                    className={`approvals-avatar${isApproved ? ' is-approved' : ''}${isRevoked ? ' is-revoked' : ' is-pending'}`}
                  />
                  <span className="approvals-row-type">{APPROVAL_LABELS[type]}</span>
                </label>
                {rowErrors[type] ? (
                  <span id={`approval-error-${type}`} className="small approvals-error" role="alert">
                    {rowErrors[type]}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
