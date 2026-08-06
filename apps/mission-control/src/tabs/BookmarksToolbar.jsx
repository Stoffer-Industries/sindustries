import React from 'react';
import { Button } from '@sindustries/ui/react';
import { DEFAULT_TIME_WINDOWS } from '../bookmarkPipeline.js';

const ALL_TOPICS = 'all';

function Field({ label, children, ...props }) {
  return (
    <label className="bookmarks-tab__field" {...props}>
      <span className="bookmarks-tab__field-label">{label}</span>
      {children}
    </label>
  );
}

function Select(props) {
  return <select {...props} className={`bookmarks-tab__select ${props.className ?? ''}`} />;
}

export function BookmarksToolbar({ windowValue, onWindowChange, topic, onTopicChange, topics, onRefresh }) {
  return (
    <div className="bookmarks-tab__toolbar" data-testid="pulse-bookmarks-toolbar">
      <Field label="Time window">
        <Select
          aria-label="Time window"
          value={windowValue}
          onChange={(e) => onWindowChange(e.target.value)}
        >
          {DEFAULT_TIME_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Topic">
        <Select
          aria-label="Topic"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
        >
          <option value={ALL_TOPICS}>All</option>
          {topics.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        variant="primary"
        onClick={onRefresh}
        data-testid="pulse-bookmarks-refresh"
      >
        Refresh
      </Button>
    </div>
  );
}