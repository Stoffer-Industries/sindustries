// Constants and pure helpers used by ContentSchedulerTab and its sub-components.
// Extracted from ContentSchedulerTab.jsx during the 2026-W30 code-garden refactor
// (audit finding 2-A: extract `useContentScheduler` hook + sub-components).

export const ACTOR = 'Tom';

export const SOURCES = [
  { value: 'ops_notes', label: 'Ops notes' },
  { value: 'cto_craft', label: 'CTO Craft' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Other' }
];

export const STATUS_LABELS = {
  queued: 'Queued',
  approved: 'Approved',
  published: 'Published'
};

export const STATUS_BADGE_VARIANT = {
  queued: 'neutral',
  approved: 'info',
  published: 'success'
};

export const DROP_REFUSED_MESSAGE = 'Already has a published post — choose another day.';

export function defaultScheduledFor() {
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  // Snap to nearest 5 minutes.
  const minutes = d.getMinutes();
  d.setMinutes(minutes - (minutes % 5));
  // datetime-local needs YYYY-MM-DDTHH:mm in local time.
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toDatetimeLocal(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return '';
  const pad = (n) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocal(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}

export function dayStatusLabel(today) {
  if (!today) return '';
  if (today.publishedCount >= today.cap) {
    return `✓ ${today.publishedCount} / ${today.cap} posts published today (max reached)`;
  }
  return `✓ ${today.publishedCount} / ${today.cap} posts published today`;
}

export function isPublishDisabled(item, today) {
  if (!item.approvedAt) return true;
  if (!today) return false;
  if (today.publishedCount >= today.cap && today.publishedItemId !== item.id) return true;
  return false;
}

export function publishTooltip(item, today) {
  if (!item.approvedAt) return 'Approve before publishing (AC6).';
  if (today?.publishedCount >= today?.cap && today?.publishedItemId !== item.id) {
    return 'Max one X post per day — already published today.';
  }
  return '';
}