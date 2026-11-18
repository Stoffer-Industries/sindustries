import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MarkdownContent } from './MarkdownContent.jsx';

const DESCRIPTION = [
  'Plain paragraph text.',
  '',
  '- [ ] first AC',
  '- [x] second AC',
  '',
  'See [the spec](#spec).',
  '',
  '- [ ] AC with a [link](#row-link) inside',
].join('\n');

function setup(onCheckboxToggle = vi.fn()) {
  const { container } = render(
    <MarkdownContent markdown={DESCRIPTION} onCheckboxToggle={onCheckboxToggle} />
  );
  return {
    onCheckboxToggle,
    container,
    checkboxes: container.querySelectorAll('input[type="checkbox"]'),
    // `marked` v17 emits no class on task-list items, so the rows are matched
    // by the checkbox they own.
    rows: Array.from(container.querySelectorAll('li')).filter((li) =>
      li.querySelector('input[type="checkbox"]')
    ),
  };
}

/**
 * React attaches its delegated listener to the root container, and the RTL
 * container IS that root. A listener added here therefore runs AFTER React's
 * handler, so `defaultPrevented` is a faithful read of whether the classifier
 * cancelled the browser default.
 */
function observeDefaultPrevented(container, run) {
  const seen = [];
  const listener = (event) => seen.push(event.defaultPrevented);
  container.addEventListener('click', listener);
  try {
    run();
  } finally {
    container.removeEventListener('click', listener);
  }
  return seen;
}

/**
 * A listener on `document.body` sits ABOVE the React root container, so it
 * only fires for clicks that were never claimed by the classifier.
 */
function observeReachingAncestor(run) {
  const seen = [];
  const listener = (event) => seen.push(event.defaultPrevented);
  document.body.addEventListener('click', listener);
  try {
    run();
  } finally {
    document.body.removeEventListener('click', listener);
  }
  return seen;
}

describe('MarkdownContent interaction classifier', () => {
  it('toggles the clicked checkbox with its rendered index', () => {
    const { onCheckboxToggle, checkboxes } = setup();

    fireEvent.click(checkboxes[0]);

    expect(onCheckboxToggle).toHaveBeenCalledTimes(1);
    const [, index, meta] = onCheckboxToggle.mock.calls[0];
    expect(index).toBe(0);
    expect(meta).toEqual({ source: 'checkbox', checked: true });
  });

  it('toggles the checkbox when the acceptance-criteria row text is clicked', () => {
    const { onCheckboxToggle, rows } = setup();

    fireEvent.click(rows[0]);

    expect(onCheckboxToggle).toHaveBeenCalledTimes(1);
    const [, index, meta] = onCheckboxToggle.mock.calls[0];
    expect(index).toBe(0);
    expect(meta).toEqual({ source: 'row', checked: true });
  });

  it('resolves the row click to that row’s own checkbox, not a per-row counter', () => {
    const { onCheckboxToggle, rows } = setup();

    fireEvent.click(rows[1]);

    const [, index, meta] = onCheckboxToggle.mock.calls[0];
    expect(index).toBe(1);
    // The second criterion is already checked, so a row click unchecks it.
    expect(meta).toEqual({ source: 'row', checked: false });
  });

  it('does not toggle a checkbox when a link is clicked', () => {
    const { onCheckboxToggle, container } = setup();
    const link = container.querySelector('a[href]');

    fireEvent.click(link);

    expect(onCheckboxToggle).not.toHaveBeenCalled();
  });

  it('does not prevent the browser default for a link, so new-tab navigation survives', () => {
    const { container } = setup();
    const link = container.querySelector('a[href]');

    const seen = observeDefaultPrevented(container, () => {
      fireEvent.click(link, { metaKey: true });
    });

    expect(seen).toEqual([false]);
  });

  it('prefers the link over the row when a link sits inside an acceptance-criteria row', () => {
    const { onCheckboxToggle, container } = setup();
    const rowLink = container.querySelector('li a[href]');

    fireEvent.click(rowLink);

    expect(onCheckboxToggle).not.toHaveBeenCalled();
  });

  it('leaves plain description text alone so click-to-edit still works', () => {
    const { onCheckboxToggle, container } = setup();
    const paragraph = container.querySelector('p');

    fireEvent.click(paragraph);

    expect(onCheckboxToggle).not.toHaveBeenCalled();
  });

  it('stops a claimed click before it reaches an edit-on-click ancestor', () => {
    const { container } = setup();

    const rowSeen = observeReachingAncestor(() => {
      fireEvent.click(container.querySelector('li'));
    });
    const linkSeen = observeReachingAncestor(() => {
      fireEvent.click(container.querySelector('a[href]'));
    });

    expect(rowSeen).toEqual([]);
    expect(linkSeen).toEqual([]);
  });

  it('lets a plain-text click reach an edit-on-click ancestor', () => {
    const { container } = setup();

    const seen = observeReachingAncestor(() => {
      fireEvent.click(container.querySelector('p'));
    });

    expect(seen).toEqual([false]);
  });

  it('renders inert content when no toggle handler is supplied', () => {
    const { container } = render(<MarkdownContent markdown={DESCRIPTION} />);

    expect(() => fireEvent.click(container.querySelector('input[type="checkbox"]'))).not.toThrow();
  });
});
