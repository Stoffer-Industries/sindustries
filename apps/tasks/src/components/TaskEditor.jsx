import { useEffect, useRef, useState } from 'react';
import { Button, Card, Divider, Field, Input, Select, Textarea } from '@sindustries/ui/react';
import { STATUSES, STATUS_LABELS, PRIORITIES, ASSIGNEE_OPTIONS } from '../utils/constants.js';
import { normalizeComments, formatCommentTimestamp } from '../utils/helpers.js';
import { MarkdownContent } from './MarkdownContent.jsx';
import { TaskCardSummary } from './TaskCardSummary.jsx';

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
  const [commentDraft, setCommentDraft] = useState({ author: '', text: '' });
  const [isCommentComposerOpen, setIsCommentComposerOpen] = useState(false);
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);

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
      blocked: draft.blocked
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
    blockedRef
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

  return (
    <div className="task-card-editor" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="task-editor-view-card"
        onClick={onClose}
        aria-label="Close task editor and show card view"
      >
        <TaskCardSummary task={task} hasDraft={isDirty} />
      </button>

      <Divider variant="dashed" />

      <Field label="Title" className="task-editor-title-field">
        <div className="task-editor-title-row">
          <Input
            ref={titleRef}
            className="task-card-title-input"
            aria-label="Detail title"
            value={draft.title}
            onChange={(e) => update('title', e.target.value)}
            onMouseDown={stopPropagation}
            onTouchStart={stopPropagation}
            onKeyDown={(e) => handleKeyDown(e, titleRef, false)}
            autoFocus
          />
          <Button type="button" variant="ghost" tone="display" className="title-close-btn" onClick={onClose}>
            Close
          </Button>
        </div>
      </Field>

      <div className="editor-fields">
        <div className="description-field">
          <div className="description-header">
            <span className="small">Description</span>
          </div>
          {isDescriptionEditing ? (
            <Textarea
              ref={descriptionRef}
              className="auto-grow-textarea"
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
          <Field label="Status">
            <Select ref={statusRef} aria-label="Detail status" value={draft.status} onChange={(e) => update('status', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, statusRef)}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>{STATUS_LABELS[status]}</option>
              ))}
            </Select>
          </Field>

          <Field label="Priority">
            <Select ref={priorityRef} aria-label="Detail priority" value={draft.priority} onChange={(e) => update('priority', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, priorityRef)}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </Select>
          </Field>

          <Field label="Assignee">
            <Select ref={assigneeRef} aria-label="Detail assignee" value={draft.assignee} onChange={(e) => update('assignee', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, assigneeRef, false)}>
              <option value="">Unassigned</option>
              {ASSIGNEE_OPTIONS.map((assignee) => (
                <option key={assignee} value={assignee}>{assignee}</option>
              ))}
            </Select>
          </Field>

          <Field label="Due date">
            <Input ref={dueAtRef} aria-label="Detail due date" type="date" value={draft.dueAt} onChange={(e) => update('dueAt', e.target.value)} onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, dueAtRef)} />
          </Field>
        </div>

        <Field label="Tags (comma separated)">
          <Input ref={tagsRef} aria-label="Detail tags" value={draft.tagsText} onChange={(e) => update('tagsText', e.target.value)} placeholder="api, ui, urgent" onMouseDown={stopPropagation} onTouchStart={stopPropagation} onKeyDown={(e) => handleKeyDown(e, tagsRef, false)} />
        </Field>

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
        </div>
      </div>

      <div className="editor-actions">
        <div className="editor-primary-actions">
          <Button
            type="button"
            variant="primary"
            tone="display"
            onClick={() => onSave(buildSavePayload())}
          >
            Save changes
          </Button>
          <div className="editor-secondary-actions">
            <Button type="button" variant="outline" tone="display" onClick={onArchive}>Archive task</Button>
            <Button type="button" variant="ghost" tone="display" onClick={onClose}>Close</Button>
          </div>
        </div>

        <Divider variant="dashed" />

        <div className="comments-section">
          <div className="comments-header">
            <h4 className="si-font-display">Comments</h4>
            <div className="comments-header-actions">
              <span className="small comments-count">{comments.length === 0 ? 'No comments yet' : `${comments.length} comment${comments.length === 1 ? '' : 's'}`}</span>
              <Button
                variant={isCommentComposerOpen ? 'ghost' : 'primary'}
                tone="display"
                type="button"
                aria-expanded={isCommentComposerOpen}
                aria-controls="task-comment-composer"
                onClick={() => setIsCommentComposerOpen((current) => !current)}
              >
                {isCommentComposerOpen ? 'Close' : 'Comment'}
              </Button>
            </div>
          </div>

          {isCommentComposerOpen ? (
            <div id="task-comment-composer" className="comment-composer">
              <Field label="Comment author">
                <Input
                  aria-label="Comment author"
                  value={commentDraft.author}
                  onChange={(e) => setCommentDraft((current) => ({ ...current, author: e.target.value }))}
                  onMouseDown={stopPropagation}
                  onTouchStart={stopPropagation}
                />
              </Field>
              <Field label="Comment">
                <Textarea
                  aria-label="Comment text"
                  value={commentDraft.text}
                  rows={3}
                  onChange={(e) => setCommentDraft((current) => ({ ...current, text: e.target.value }))}
                  onMouseDown={stopPropagation}
                  onTouchStart={stopPropagation}
                />
              </Field>
              <div className="actions">
                <Button
                  variant="primary"
                  tone="display"
                  type="button"
                  onClick={() => void handleAddComment()}
                  disabled={isSubmittingComment || !commentDraft.author.trim() || !commentDraft.text.trim()}
                >
                  {isSubmittingComment ? 'Adding…' : 'Add comment'}
                </Button>
              </div>
            </div>
          ) : null}

          {comments.length > 0 ? (
            <ol className="comments-list" aria-label="Task comments">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <Card variant="pulse" className="comment-card">
                    <div className="comment-meta">
                      <strong>{comment.author}</strong>
                      <time className="small" dateTime={comment.createdAt}>{formatCommentTimestamp(comment.createdAt)}</time>
                    </div>
                    <MarkdownContent markdown={comment.text} className="comment-body" />
                  </Card>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}
