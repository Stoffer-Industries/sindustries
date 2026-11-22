import { expect } from '@playwright/test';

/**
 * Deterministically drag a task card onto a board column.
 *
 * The board uses native HTML5 drag-and-drop: the card's `dragstart` handler
 * writes the task id into `dataTransfer` (`text/plain`) and the column's `drop`
 * handler reads it back. `locator.dragTo()` drives the browser's own drag
 * controller, which can deliver `drop` before the page's `dragstart` handler
 * has populated the payload — the drop then becomes a no-op and the request
 * list stays empty. It also resolves before the intercepted request reaches
 * the route handler, so an immediate assertion on that request list is a race
 * on its own.
 *
 * This helper removes both dependencies:
 *
 * - The three drag events are dispatched explicitly, in order, each one awaited,
 *   so `dragstart` has provably run before `drop` is dispatched.
 * - All three events share **one** `DataTransfer` handle, so the payload the
 *   card writes is the payload the column reads.
 *
 * `bubbles`/`cancelable`/`composed` are set explicitly: React delegates drag
 * events at the root container and only sees events that bubble.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} cardTestId     e.g. `card-gated-task`
 * @param {string} columnTestId   e.g. `column-acceptance`
 */
export async function dragCardToColumn(page, cardTestId, columnTestId) {
  const card = page.getByTestId(cardTestId);
  const column = page.getByTestId(columnTestId);

  await expect(card).toBeVisible();
  await expect(column).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());

  const init = { dataTransfer, bubbles: true, cancelable: true, composed: true };

  // `dragstart` populates the payload; awaiting the dispatch guarantees the
  // card's handler has run before the drop is delivered.
  await card.dispatchEvent('dragstart', init);
  // `dragover` is what the column cancels to allow a drop.
  await column.dispatchEvent('dragover', init);
  // `drop` reads the payload back and issues the PATCH.
  await column.dispatchEvent('drop', init);

  return dataTransfer;
}
