import { Avatar, Badge } from '@sindustries/ui/react';
import { assigneeInitial } from '../utils/helpers.js';
import { PRIORITIES } from '../utils/constants.js';

function priorityVariant(priority) {
  return PRIORITIES.includes(priority) ? priority : 'neutral';
}

function taskCardDate(task) {
  const raw = task.dueAt ?? task.statusChangedAt;
  return raw ? String(raw).slice(0, 10) : '';
}

function taskCardTags(task) {
  if (!Array.isArray(task.tags)) return [];
  return task.tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.name ?? ''))
    .filter(Boolean);
}

/**
 * Read-only task card body used in list/board views and the editor preview strip.
 */
export function TaskCardSummary({ task, hasDraft, onTitleClick }) {
  const date = taskCardDate(task);
  const tags = taskCardTags(task);
  const assignee = assigneeInitial(task.assignee);
  const TitleTag = onTitleClick ? 'button' : 'div';

  return (
    <>
      <TitleTag
        type={onTitleClick ? 'button' : undefined}
        className="task-card-title"
        onClick={onTitleClick}
      >
        {task.title}
      </TitleTag>
      <div className="task-card-footer">
        <div className="task-card-footer-tags">
          <Badge variant={priorityVariant(task.priority)} tone="pulse">
            {task.priority}
          </Badge>
          {tags.map((tag) => (
            <Badge key={tag} variant="tag" tone="pulse">
              {tag}
            </Badge>
          ))}
          {hasDraft ? <Badge variant="draft" tone="pulse">Unsaved</Badge> : null}
        </div>
        <div className="task-card-footer-meta">
          {assignee ? (
            <Avatar aria-label={`Assignee ${task.assignee}`}>
              {assignee}
            </Avatar>
          ) : null}
          {date ? <time className="task-card-date" dateTime={date}>{date}</time> : null}
        </div>
      </div>
    </>
  );
}
