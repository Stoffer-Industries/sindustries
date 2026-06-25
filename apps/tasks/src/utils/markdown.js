import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for safe, sensible defaults.
// marked.use accepts the same option keys as the deprecated setOptions,
// so this is a behavior-equivalent migration from marked v17's deprecation.
marked.use({
  gfm: true,
  breaks: true,
});

/**
 * Render markdown string to sanitized HTML.
 * @param {string} markdown - Raw markdown text
 * @returns {string} Sanitized HTML string
 */
export function renderMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';
  const rawHtml = marked.parse(markdown);
  const sanitized = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'blockquote',
      'pre', 'code',
      'strong', 'em', 'del', 's',
      'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input',  // for checkboxes
      'img',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'type', 'checked', 'disabled', 'src', 'alt'],
  });

  // `marked` emits disabled checkboxes for task lists. We want them to visually match
  // the rest of the app's checkboxes (amber accent) which some browsers don't apply
  // when the input is disabled.
  return sanitized.replaceAll(' disabled=""', '').replaceAll(' disabled', '');
}
