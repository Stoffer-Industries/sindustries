import { useEffect, useMemo, useState } from 'react';
import {
  createAttentionOwner,
  deleteAttentionOwner,
  fetchAuthSession,
  resolveOwnAttentionOwner,
  updateAttentionOwner
} from '../tasksApi.ts';
import { assigneeDisplayName } from '../users/assignees.js';

/**
 * In-task management surface for the attention-owner stack (AC6).
 *
 * Renders one row per `attentionOwnerDetails` entry with inline edit,
 * move up / move down, and remove controls. Adds an "Add attention
 * owner" composer that requires both owner and reason inputs before the
 * submit button enables. Renders a "Resolve my blocker" button only for
 * the authenticated top-of-stack actor (AC5).
 *
 * The panel owns no clipboard or toast logic; status text is rendered
 * inline so the editor surface stays self-contained. Re-renders against
 * the mapper response of every mutation so the parent component stays in
 * sync via the optional `onTaskRefresh` callback.
 */
export function AttentionOwnersPanel({ task, onTaskRefresh, readOnly = false }) {
  const [actor, setActor] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');
  const [editingRowId, setEditingRowId] = useState(null);
  const [pendingRowId, setPendingRowId] = useState(null);
  const [composer, setComposer] = useState({ owner: '', note: '', position: '' });
  const [composerError, setComposerError] = useState(null);
  const [rowErrors, setRowErrors] = useState({});
  const [globalError, setGlobalError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const details = useMemo(() => {
    if (!Array.isArray(task?.attentionOwnerDetails)) return [];
    return [...task.attentionOwnerDetails].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }, [task]);

  const topOwner = details[0]?.owner ?? null;
  const canResolve = !readOnly && actor && topOwner && sameOwner(actor, topOwner);

  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((current) => {
        if (cancelled) return;
        setActor(current?.actor ?? current?.username ?? null);
        setAuthStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setAuthStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function flashError(map, message) {
    setRowErrors(map);
    setGlobalError(message);
  }

  function clearFlash() {
    setRowErrors({});
    setGlobalError(null);
    setSuccessMessage(null);
  }

  async function refreshTask() {
    if (typeof onTaskRefresh === 'function') {
      try {
        await onTaskRefresh();
      } catch (err) {
        setGlobalError(err?.message ?? 'Refresh failed');
      }
    }
  }

  async function handleAdd(event) {
    event.preventDefault();
    clearFlash();
    const owner = composer.owner.trim();
    const note = composer.note.trim();
    if (!owner || !note) {
      setComposerError('Both owner and reason are required.');
      return;
    }
    const positionRaw = composer.position.trim();
    const position = positionRaw === '' ? undefined : Number.parseInt(positionRaw, 10);
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
      setComposerError('Position must be a non-negative integer when supplied.');
      return;
    }
    setComposerError(null);
    setPendingRowId('__new__');
    try {
      await createAttentionOwner(task.id, {
        owner,
        note,
        position
      });
      setComposer({ owner: '', note: '', position: '' });
      setSuccessMessage(`Added "${owner}" with reason.`);
      await refreshTask();
    } catch (err) {
      setComposerError(err?.message ?? 'Could not add attention owner.');
    } finally {
      setPendingRowId(null);
    }
  }

  async function handleResolve() {
    if (!canResolve) return;
    clearFlash();
    setPendingRowId('__self__');
    try {
      const response = await resolveOwnAttentionOwner(task.id);
      setSuccessMessage(`Resolved. Top is now ${response?.nextTopOwner ?? '(empty)'}.`);
      await refreshTask();
    } catch (err) {
      flashError({}, err?.message ?? 'Could not resolve blocker.');
    } finally {
      setPendingRowId(null);
    }
  }

  async function handleRemove(row, reason) {
    clearFlash();
    setPendingRowId(row.id);
    try {
      await deleteAttentionOwner(task.id, row.id, reason);
      setSuccessMessage(`Removed "${row.owner}".`);
      await refreshTask();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: err?.message ?? 'Could not remove row.' }));
    } finally {
      setPendingRowId(null);
    }
  }

  async function handleMove(row, direction) {
    clearFlash();
    setPendingRowId(row.id);
    try {
      const targetIndex = direction === 'up' ? row.position - 1 : row.position + 1;
      if (targetIndex < 0) {
        setPendingRowId(null);
        return;
      }
      await updateAttentionOwner(task.id, row.id, { position: targetIndex });
      await refreshTask();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: err?.message ?? 'Could not move row.' }));
    } finally {
      setPendingRowId(null);
    }
  }

  async function handleEdit(row, payload) {
    clearFlash();
    setEditingRowId(null);
    setPendingRowId(row.id);
    try {
      await updateAttentionOwner(task.id, row.id, payload);
      setSuccessMessage(`Updated "${row.owner}".`);
      await refreshTask();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: err?.message ?? 'Could not update row.' }));
    } finally {
      setPendingRowId(null);
    }
  }

  if (authStatus === 'loading') {
    return (
      <section className="attention-owners-panel" aria-busy="true">
        <h3>Attention owners</h3>
        <p>Loading session…</p>
      </section>
    );
  }

  return (
    <section className="attention-owners-panel" aria-label="Attention owners">
      <h3>Attention owners</h3>
      {globalError ? (
        <p className="attention-owners-panel-error" role="alert">{globalError}</p>
      ) : null}
      {successMessage ? (
        <p className="attention-owners-panel-success" role="status">{successMessage}</p>
      ) : null}
      <ul className="attention-owners-panel-list" data-testid="attention-owners-list">
        {details.length === 0 ? (
          <li className="attention-owners-panel-empty">No attention requests on this task.</li>
        ) : null}
        {details.map((row) => (
          <AttentionOwnerRow
            key={row.id}
            row={row}
            isFirst={row.position === 0}
            isLast={row.position === details.length - 1}
            pending={pendingRowId === row.id}
            editing={editingRowId === row.id}
            error={rowErrors[row.id] ?? null}
            readOnly={readOnly}
            onStartEdit={() => {
              clearFlash();
              setEditingRowId(row.id);
            }}
            onCancelEdit={() => setEditingRowId(null)}
            onSubmitEdit={(payload) => handleEdit(row, payload)}
            onMoveUp={() => handleMove(row, 'up')}
            onMoveDown={() => handleMove(row, 'down')}
            onRemove={(reason) => handleRemove(row, reason)}
          />
        ))}
      </ul>
      {canResolve ? (
        <button
          type="button"
          className="attention-owners-panel-resolve"
          onClick={handleResolve}
          disabled={pendingRowId === '__self__'}
          data-testid="resolve-blocker"
        >
          Resolve my blocker
        </button>
      ) : null}
      {!readOnly ? (
        <form className="attention-owners-panel-composer" onSubmit={handleAdd}>
          <h4>Add attention owner</h4>
          {composerError ? (
            <p className="attention-owners-panel-error" role="alert">{composerError}</p>
          ) : null}
          <label className="attention-owners-panel-field">
            <span>Owner</span>
            <input
              type="text"
              value={composer.owner}
              maxLength={64}
              required
              onChange={(e) => setComposer({ ...composer, owner: e.target.value })}
              data-testid="composer-owner"
            />
          </label>
          <label className="attention-owners-panel-field">
            <span>Reason (required)</span>
            <textarea
              value={composer.note}
              maxLength={500}
              required
              rows={2}
              onChange={(e) => setComposer({ ...composer, note: e.target.value })}
              data-testid="composer-note"
            />
          </label>
          <label className="attention-owners-panel-field">
            <span>Position (optional, default 0)</span>
            <input
              type="number"
              min="0"
              value={composer.position}
              onChange={(e) => setComposer({ ...composer, position: e.target.value })}
              data-testid="composer-position"
            />
          </label>
          <button
            type="submit"
            disabled={!composer.owner.trim() || !composer.note.trim() || pendingRowId === '__new__'}
            data-testid="composer-submit"
          >
            {pendingRowId === '__new__' ? 'Adding…' : 'Add'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function AttentionOwnerRow({
  row,
  isFirst,
  isLast,
  pending,
  editing,
  error,
  readOnly,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onMoveUp,
  onMoveDown,
  onRemove
}) {
  const [editOwner, setEditOwner] = useState(row.owner);
  const [editNote, setEditNote] = useState(row.note ?? '');

  useEffect(() => {
    setEditOwner(row.owner);
    setEditNote(row.note ?? '');
  }, [row.owner, row.note]);

  const displayName = assigneeDisplayName(row.owner) || row.owner;
  const addedBy = row.addedBy ? assigneeDisplayName(row.addedBy) || row.addedBy : null;

  if (editing) {
    return (
      <li className="attention-owners-panel-row attention-owners-panel-row-editing" data-row-id={row.id}>
        <label className="attention-owners-panel-field">
          <span>Owner</span>
          <input
            type="text"
            value={editOwner}
            maxLength={64}
            onChange={(e) => setEditOwner(e.target.value)}
            data-testid={`edit-owner-${row.id}`}
          />
        </label>
        <label className="attention-owners-panel-field">
          <span>Reason</span>
          <textarea
            value={editNote}
            maxLength={500}
            rows={2}
            onChange={(e) => setEditNote(e.target.value)}
            data-testid={`edit-note-${row.id}`}
          />
        </label>
        <div className="attention-owners-panel-row-actions">
          <button
            type="button"
            onClick={() => onSubmitEdit({
              owner: editOwner.trim() !== row.owner ? editOwner.trim() : undefined,
              note: editNote.trim() !== (row.note ?? '') ? editNote.trim() : undefined
            })}
            disabled={pending || (!editOwner.trim() || !editNote.trim())}
            data-testid={`edit-submit-${row.id}`}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onCancelEdit} disabled={pending}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`attention-owners-panel-row${isFirst ? ' attention-owners-panel-row-top' : ''}`}
      data-row-id={row.id}
      data-position={row.position}
    >
      <div className="attention-owners-panel-row-meta">
        <span className="attention-owners-panel-position">#{row.position}</span>
        <span className="attention-owners-panel-owner">{displayName}</span>
        {addedBy ? (
          <span className="attention-owners-panel-added-by">added by {addedBy}</span>
        ) : null}
      </div>
      {row.note ? (
        <p className="attention-owners-panel-note">{row.note}</p>
      ) : (
        <p className="attention-owners-panel-note attention-owners-panel-note-empty">No reason recorded.</p>
      )}
      {error ? (
        <p className="attention-owners-panel-error" role="alert">{error}</p>
      ) : null}
      {!readOnly ? (
        <div className="attention-owners-panel-row-actions">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={pending || isFirst}
            data-testid={`move-up-${row.id}`}
            aria-label={`Move ${displayName} up`}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={pending || isLast}
            data-testid={`move-down-${row.id}`}
            aria-label={`Move ${displayName} down`}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onStartEdit}
            disabled={pending}
            data-testid={`edit-${row.id}`}
          >
            Edit
          </button>
          <button
            type="button"
            className="attention-owners-panel-remove"
            onClick={() => {
              const reason = window.prompt(`Optional reason for removing ${displayName}:`) ?? '';
              onRemove(reason || undefined);
            }}
            disabled={pending}
            data-testid={`remove-${row.id}`}
          >
            Remove
          </button>
        </div>
      ) : null}
    </li>
  );
}

function sameOwner(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}