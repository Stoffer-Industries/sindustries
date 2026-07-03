import { renderMarkdown } from '../utils/markdown.js';

/**
 * Renders markdown content as sanitized HTML.
 * @param {Object} props
 * @param {string} props.markdown - Raw markdown string
 * @param {string} [props.className] - Additional CSS class
 * @param {(event: React.MouseEvent<HTMLInputElement>, checkboxIndex: number) => void} [props.onCheckboxToggle]
 */
export function MarkdownContent({ markdown, className = '', onCheckboxToggle }) {
  const html = renderMarkdown(markdown);
  if (!html) return null;

  function handleClick(event) {
    if (!onCheckboxToggle) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;

    const root = event.currentTarget;
    const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    const checkboxIndex = checkboxes.indexOf(target);
    if (checkboxIndex === -1) return;

    onCheckboxToggle(event, checkboxIndex);
  }

  return (
    <div
      className={`markdown-body ${className}`.trim()}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
