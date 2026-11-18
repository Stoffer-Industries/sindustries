import { renderMarkdown } from '../utils/markdown.js';

/**
 * Renders markdown content as sanitized HTML.
 *
 * Click classification (task `88cd00e0`): a click inside rendered markdown is
 * resolved to exactly ONE interaction kind, in priority order:
 *
 *   1. `link`     — an `a[href]` inside this markdown. The click is NOT
 *                    default-prevented, so the browser keeps its native
 *                    Cmd/Ctrl-click "open in new tab" behaviour, and the click
 *                    is stopped so it never reaches an ancestor that treats a
 *                    click as "enter inline edit mode".
 *   2. `checkbox` — the click target is the checkbox itself. Toggles the
 *                    checkbox at its rendered index.
 *   3. `row`      — the click target sits inside a task-list `li` inside this
 *                    markdown that owns a checkbox. The row is a hit target
 *                    for that checkbox, so it toggles it too (a larger, more
 *                    forgiving target).
 *   4. `other`    — not interactive. The click bubbles untouched, so plain
 *                    description text keeps its click-to-edit behaviour.
 *
 * Link priority sits above row priority on purpose: a link inside an
 * acceptance-criteria row must open the link, not toggle the checkbox.
 *
 * Every `closest()` lookup is scoped to THIS markdown root with
 * `root.contains(...)`. Without that scope the lookup escapes the markdown and
 * matches the surrounding application: a task card is rendered inside a
 * backlog `<li>`, so an unscoped `closest('li')` resolves a plain-text click
 * to the backlog list item — which then resolves to a checkbox and toggles an
 * acceptance criterion instead of entering edit mode. An unscoped
 * `closest('a[href]')` can likewise match a link in the page chrome.
 *
 * @param {Object} props
 * @param {string} props.markdown - Raw markdown string
 * @param {string} [props.className] - Additional CSS class
 * @param {(event: React.MouseEvent, checkboxIndex: number, meta?: { source: 'checkbox'|'row', checked: boolean }) => void} [props.onCheckboxToggle]
 *        Called with the zero-based index of the checkbox in RENDERED order —
 *        the same index space `toggleMarkdownTaskCheckbox` uses — and the
 *        desired new checked state.
 */
export function MarkdownContent({ markdown, className = '', onCheckboxToggle }) {
  const html = renderMarkdown(markdown);
  if (!html) return null;

  function handleClick(event) {
    if (!onCheckboxToggle) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const root = event.currentTarget;

    // 1. Link target — never default-prevented, so native Cmd/Ctrl-click
    //    new-tab navigation survives; stopped so it never reaches an
    //    edit-on-click ancestor.
    const link = target.closest('a[href]');
    if (link && root.contains(link)) {
      event.stopPropagation();
      return;
    }

    const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));

    // 2. Checkbox target.
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      const checkboxIndex = checkboxes.indexOf(target);
      if (checkboxIndex === -1) return;
      // Claim the interaction here, not only in the consumer: a click that
      // resolves to a claimed target must never reach an ancestor that treats
      // a click as "enter inline edit mode", even if a consumer forgets to
      // stop propagation.
      event.stopPropagation();
      onCheckboxToggle(event, checkboxIndex, {
        source: 'checkbox',
        checked: target.checked,
      });
      return;
    }

    // 3. Task-list row target. `querySelector` returns the row's OWN
    //    checkbox first in document order, even when the row nests a further
    //    task list.
    const row = target.closest('li');
    if (row && root.contains(row)) {
      const rowCheckbox = row.querySelector('input[type="checkbox"]');
      if (rowCheckbox) {
        const checkboxIndex = checkboxes.indexOf(rowCheckbox);
        if (checkboxIndex === -1) return;
        event.stopPropagation();
        onCheckboxToggle(event, checkboxIndex, {
          source: 'row',
          // The row click never activated the checkbox, so its current state
          // is the pre-click state and the desired state is its opposite.
          checked: !rowCheckbox.checked,
        });
        return;
      }
    }

    // 4. Anything else — let it bubble.
  }

  return (
    <div
      className={`markdown-body ${className}`.trim()}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
