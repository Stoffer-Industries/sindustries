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

/**
 * Toggle the nth markdown task-list checkbox in raw markdown.
 * @param {string} markdown - Raw markdown text
 * @param {number} checkboxIndex - Zero-based checkbox index in rendered order
 * @param {boolean} checked - Desired checked state
 * @returns {string} Markdown with the checkbox state updated, or the original text if no match exists
 */
export function toggleMarkdownTaskCheckbox(markdown, checkboxIndex, checked) {
  if (typeof markdown !== 'string' || checkboxIndex < 0) return markdown;

  let seen = 0;
  return markdown
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*[-*+]\s+\[)( |x|X)(\]\s+.*)$/);
      if (!match) return line;
      if (seen !== checkboxIndex) {
        seen += 1;
        return line;
      }
      seen += 1;
      return `${match[1]}${checked ? 'x' : ' '}${match[3]}`;
    })
    .join('\n');
}
