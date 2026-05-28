import { useEffect, useRef, useState } from 'react';
import { STATUSES, STATUS_LABELS, PRIORITIES, ASSIGNEE_OPTIONS } from '../utils/constants.js';
import { normalizeComments, normalizeHistory, formatCommentTimestamp, formatHistoryTimestamp } from '../utils/helpers.js';
import { MarkdownContent } from './MarkdownContent.jsx';

/**
 * TaskEditor - Inline editor for task details
 * @param {Object} props
 * @param {Object} props.draft - Current draft state
 * @param {Object} props.task - Original task data
 * @param {boolean} props.isDirty - Whether there are unsaved changes
 * @param {Function} props.onDraftChange - Callback when draft changes
 * @param {Function} props.onSave - Callback to save changes
 * @param {Function} props.onArchive - Callback to archive task
 * @param {Function} props.onClose - Callback to close editor
 * @param {Function} props.onAddComment - Callback to add comment
 * @param {boolean} props.isSubmittingComment - Whether comment is being submitted
 */
export function TaskEditor({ draft, task, isDirty, onDraftChange, onSave, onArchive, onClose, onAddComment, isSubmittingComment }) {
  const descriptionRef = useRef(null);
  const titleRef = useRef(null);
  const statusRef = useRef(null);
  const priorityRef = useRef(null);
  const assigneeRef = useRef(null);
  const dueAtRef = useRef(null);
  const tagsRef = useRef(null);
  const blockedRef = useRef(null);
  const readyRef = useRef(null);
  const [commentDraft, setCommentDraft] = useState({ author: '', text: '' });
  const [isCommentComposerOpen, setIsCommentComposerOpen] = useState(false);
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('comments');

  useEffect(() => {
    const textarea = descriptionRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.description, isDescriptionEditing]);

  useEffect(() => {
    if (!isDescriptionEditing) return;
    // Ensure the textarea is mounted before measuring.
    requestAnimationFrame(() => {
      const textarea = descriptionRef.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
  }, [isDescriptionEditing]);

  /** @param {string} field */
  /** @param {any} value */
  function update(field, value) {
    onDraftChange({ ...draft, [field]: value });
  }

  /** @param {React.MouseEvent} e */
  function stopPropagation(e) {
    e.stopPropagation();
  }

  function buildSavePayload() {
    return {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      status: draft.status,
      priority: draft.priority,
      assignee: draft.assignee.trim() || null,
      dueAt: draft.dueAt ? new Date(`${draft.dueAt}T00:00:00`).toISOString() : null,
      tags: draft.tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      blocked: draft.blocked,
      ready: draft.ready,
      actor: 'tasks-ui'
    };
  }

  const focusOrder = [
    titleRef,
    descriptionRef,
    statusRef,
    priorityRef,
    assigneeRef,
    dueAtRef,
    tagsRef,
    blockedRef,
    readyRef
  ];

  /**
   * @param {React.RefObject<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>} currentRef
   * @returns {boolean}
   */
  function focusNextField(currentRef) {
    const currentIndex = focusOrder.findIndex((ref) => ref === currentRef);
    const nextRef = focusOrder[currentIndex + 1];
    if (nextRef?.current) {
      nextRef.current.focus();
      if (typeof nextRef.current.select === 'function') {
        nextRef.current.select();
      }
      return true;
    }
    return false;
  }

  /**
   * @param {React.KeyboardEvent} e
   * @param {React.RefObject<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>} currentRef
   * @param {boolean} [isMultiLine]
   */
  function handleKeyDown(e, currentRef, isMultiLine = false) {
    if (e.key !== 'Enter' || e.shiftKey) {
      return;
    }

    e.preventDefault();

    if (!focusNextField(currentRef)) {
      onSave(buildSavePayload());
    }
  }

  async function handleAddComment() {
    const payload = {
      author: commentDraft.author.trim(),
      text: commentDraft.text.trim()
    };

    if (!payload.author || !payload.text) return;

    const didCreate = await onAddComment(payload);
    if (!didCreate) return;
    setCommentDraft({ author: '', text: '' });
    setIsCommentComposerOpen(false);
  }

  const comments = [...normalizeComments(task.comments)].sort((a, b) => {
    const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return String(b.id ?? '').localeCompare(String(a.id ?? ''));
  });

  const history = [...normalizeHistory(task.history)].sort((a, b) => {
    const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return String(b.id ?? '').localeCompare(String(a.id ?? ''));
  });

  function formatHistoryValue(value) {
    if (value === null || value === undefined || value === '') return 'empty';
    if (value === 'true') return 'on';
    if (value === 'false') return 'off';
    return String(value);
  }

  return (
    <div className="editor" onClick={(e) => e.stopPropagation()}>
      <div className="editor-fields">
        <div className="title-row">
          <label>
            <span className="small">Title</span>
            <input ref={titleRef} className="edit-control" aria-label="Detail title" value={draft.title} onChange={(e) => update('title', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, titleRef, false)} autoFocus />
          </label>
          {/* AC6: Close button in title section */}
          <button className="tertiary-btn title-close-btn" onClick={onClose}>Close</button>
        </div>

        <div className="description-field">
          <div className="description-header">
            <span className="small">Description</span>
          </div>
          {isDescriptionEditing ? (
            <textarea
              ref={descriptionRef}
              className="edit-control auto-grow-textarea"
              aria-label="Detail description"
              value={draft.description}
              rows={1}
              onChange={(e) => update('description', e.target.value)}
              onMouseDown={stopPropagation}
              onTouchStart={stopPropagation}
              onFocus={() => {
                const textarea = descriptionRef.current;
                if (!textarea) return;
                textarea.style.height = 'auto';
                textarea.style.height = `${textarea.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsDescriptionEditing(false);
                  return;
                }
                handleKeyDown(e, descriptionRef, true);
              }}
              onBlur={() => setIsDescriptionEditing(false)}
            />
          ) : (
            <div
              className="description-preview"
              onClick={() => setIsDescriptionEditing(true)}
              role="button"
              tabIndex={0}
              aria-label="Click to edit description"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsDescriptionEditing(true); } }}
            >
              {draft.description ? (
                <MarkdownContent markdown={draft.description} />
              ) : (
                <p className="description-empty">No description. Click to add one.</p>
              )}
            </div>
          )}
        </div>

        <div className="editor-grid">
          <label>
            <span className="small">Status</span>
            <select ref={statusRef} className="edit-control" aria-label="Detail status" value={draft.status} onChange={(e) => update('status', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, statusRef)}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>{STATUS_LABELS[status]}</option>
              ))}
            </select>
          </label>

          <label>
            <span className="small">Priority</span>
            <select ref={priorityRef} className="edit-control" aria-label="Detail priority" value={draft.priority} onChange={(e) => update('priority', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, priorityRef)}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </label>

          <label>
            <span className="small">Assignee</span>
            <select ref={assigneeRef} className="edit-control" aria-label="Detail assignee" value={draft.assignee} onChange={(e) => update('assignee', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, assigneeRef, false)}>
              <option value="">Unassigned</option>
              {ASSIGNEE_OPTIONS.map((assignee) => (
                <option key={assignee} value={assignee}>{assignee}</option>
              ))}
            </select>
          </label>

          <label>
            <span className="small">Due date</span>
            <input ref={dueAtRef} className="edit-control" aria-label="Detail due date" type="date" value={draft.dueAt} onChange={(e) => update('dueAt', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, dueAtRef)} />
          </label>
        </div>

        <label>
          <span className="small">Tags (comma separated)</span>
          <input ref={tagsRef} className="edit-control" aria-label="Detail tags" value={draft.tagsText} onChange={(e) => update('tagsText', e.target.value)} placeholder="api, ui, urgent" onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, tagsRef, false)} />
        </label>

        <div className="editor-toggles">
          <label className="toggle-label">
            <input
              ref={blockedRef}
              aria-label="Detail blocked"
              type="checkbox"
              checked={draft.blocked}
              onChange={(e) => update('blocked', e.target.checked)}
              onKeyDown={(e) => handleKeyDown(e, blockedRef)}
            />
            <span>Blocked</span>
          </label>
          <label className="toggle-label">
            <input
              ref={readyRef}
              aria-label="Detail ready"
              type="checkbox"
              checked={draft.ready}
              onChange={(e) => update('ready', e.target.checked)}
              onKeyDown={(e) => handleKeyDown(e, readyRef)}
            />
            <span>Ready</span>
          </label>
        </div>
      </div>

      <div className="actions editor-actions">
        <div className="editor-primary-actions">
          <button
            className="primary-btn font-display"
            onClick={() => onSave(buildSavePayload())}
          >
            Save changes
          </button>
          <div className="editor-secondary-actions">
            <button className="secondary-btn font-display" onClick={onArchive}>Archive task</button>
            <button className="tertiary-btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="comments-section">
          <div className="task-tabs" role="tablist" aria-label="Task activity">
            <button
              id="task-comments-tab"
              type="button"
              className={`task-tab ${activeTab === 'comments' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'comments'}
              aria-controls="task-comments-panel"
              onClick={() => setActiveTab('comments')}
            >
              Comments
            </button>
            <button
              id="task-history-tab"
              type="button"
              className={`task-tab ${activeTab === 'history' ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === 'history'}
              aria-controls="task-history-panel"
              onClick={() => setActiveTab('history')}
            >
              History
            </button>
          </div>

          {activeTab === 'comments' ? (
            <div id="task-comments-panel" role="tabpanel" aria-labelledby="task-comments-tab">
              <div className="comments-header">
                <h4 className="font-display">Comments</h4>
                <div className="comments-header-actions">
                  <span className="small comments-count">{comments.length === 0 ? 'No comments yet' : `${comments.length} comment${comments.length === 1 ? '' : 's'}`}</span>
                  <button
                    className={`${isCommentComposerOpen ? 'tertiary-btn' : 'primary-btn font-display'}`}
                    type="button"
                    aria-expanded={isCommentComposerOpen}
                    aria-controls="task-comment-composer"
                    onClick={() => setIsCommentComposerOpen((current) => !current)}
                  >
                    {isCommentComposerOpen ? 'Close' : 'Comment'}
                  </button>
                </div>
              </div>

              {isCommentComposerOpen ? (
                <div id="task-comment-composer" className="comment-composer">
                  <label>
                    <span className="small">Comment author</span>
                    <input
                      className="edit-control"
                      aria-label="Comment author"
                      value={commentDraft.author}
                      onChange={(e) => setCommentDraft((current) => ({ ...current, author: e.target.value }))}
                      onMouseDown={stopPropagation}
                      onTouchStart={stopPropagation}
                    />
                  </label>
                  <label>
                    <span className="small">Comment</span>
                    <textarea
                      className="edit-control"
                      aria-label="Comment text"
                      value={commentDraft.text}
                      rows={3}
                      onChange={(e) => setCommentDraft((current) => ({ ...current, text: e.target.value }))}
                      onMouseDown={stopPropagation}
                      onTouchStart={stopPropagation}
                    />
                  </label>
                  <div className="actions">
                    <button
                      className="primary-btn font-display"
                      type="button"
                      onClick={() => void handleAddComment()}
                      disabled={isSubmittingComment || !commentDraft.author.trim() || !commentDraft.text.trim()}
                    >
                      {isSubmittingComment ? 'Adding…' : 'Add comment'}
                    </button>
                  </div>
                </div>
              ) : null}

              {comments.length > 0 ? (
                <ol className="comments-list" aria-label="Task comments">
                  {comments.map((comment) => (
                    <li key={comment.id} className="comment-card">
                      <div className="comment-meta">
                        <strong>{comment.author}</strong>
                        <time className="small" dateTime={comment.createdAt}>{formatCommentTimestamp(comment.createdAt)}</time>
                      </div>
                      <MarkdownContent markdown={comment.text} className="comment-body" />
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : (
            <div id="task-history-panel" role="tabpanel" aria-labelledby="task-history-tab">
              <div className="comments-header">
                <h4 className="font-display">History</h4>
                <span className="small comments-count">{history.length === 0 ? 'No history yet' : `${history.length} change${history.length === 1 ? '' : 's'}`}</span>
              </div>

              {history.length > 0 ? (
                <ol className="history-list" aria-label="Task history">
                  {history.map((entry) => (
                    <li key={entry.id} className="history-card">
                      <div className="history-dot" aria-hidden="true" />
                      <div className="history-content">
                        <div className="history-main">
                          <strong>{entry.field}</strong>
                          <span>{formatHistoryValue(entry.oldValue)} -&gt; {formatHistoryValue(entry.newValue)}</span>
                        </div>
                        <div className="comment-meta">
                          <strong>{entry.actor}</strong>
                          <time className="small" dateTime={entry.createdAt}>{formatHistoryTimestamp(entry.createdAt)}</time>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="comments-empty">State changes will appear here after status, blocked, or ready changes.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
