import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// The description of the task that was reported as overflowing, captured
// verbatim from the Tasks API. The reported defect is content-driven, so a
// fixture of the wrong shape would let this suite pass while the real task
// still overflows. Using the real description removes that doubt: its longest
// unbreakable tokens are a 67-character branch name and several 58+ character
// PR URLs.
const REAL_DESCRIPTION = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'task-5cb4a8fe-description.md'),
  'utf8'
);

const TASK_ID = '5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c';

// The measured longest tokens of the reported task.
const LONG_BRANCH =
  'task-5cb4a8fe-6069-4b3c-b2ef-0b8dc61cdb3c-stable-app-name-hostnames'; // 67 chars
const LONG_URL = 'https://github.com/Stoffer-Industries/sindustries/pull/1020'; // 59 chars

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'narrow-1024', width: 1024, height: 800 },
];

// Sub-pixel rounding tolerance. Layout is measured in fractional pixels, so a
// containment assertion needs a little slack to avoid failing on rounding.
const EPSILON = 1;

function makeTask(overrides = {}) {
  return {
    id: TASK_ID,
    title: '🔧 Add stable app-name hostnames for staging and production',
    description: REAL_DESCRIPTION,
    status: 'acceptance',
    statusChangedAt: new Date().toISOString(),
    priority: 'medium',
    dueAt: null,
    archivedAt: null,
    blocked: false,
    tags: ['cloud', 'rowan', 'production', 'staging', 'dns'],
    taskType: 'code',
    approvals: [],
    comments: [],
    dependsOnIds: [],
    ...overrides
  };
}

async function seed(page, tasks) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const idMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && /\/auth\/session$/.test(url.pathname)) {
      await route.fulfill({ status: 401, json: { error: { message: 'Unauthenticated' } } });
      return;
    }
    if (method === 'GET' && /\/task-types\/[^/]+\/required-approvals$/.test(url.pathname)) {
      await route.fulfill({
        json: { data: { taskType: 'code', requiredApprovals: ['qa_agent'], version: 1, source: 'builtin-default' } }
      });
      return;
    }
    if (method === 'GET' && /\/tasks$/.test(url.pathname)) {
      await route.fulfill({ json: { data: tasks } });
      return;
    }
    if (method === 'GET' && idMatch) {
      await route.fulfill({ json: { data: tasks.find((t) => t.id === idMatch[1]) ?? tasks[0] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });
}

/**
 * The containment probe. Returns every way in which a card fails to contain
 * its own content:
 *
 *  - `escapes-card-content-box` — a descendant paints outside the card's
 *    content box. This is the reported symptom: the card's box stays inside
 *    its column, but its content (the editor grid, the title, the footer)
 *    paints past the column edge and into the neighbouring lane.
 *  - `internal-overflow` — a descendant's content is wider than its own box
 *    and the box does not clip or scroll it, so it spills out of that box.
 *  - `card-internal-overflow` — the card's own scroll width exceeds its
 *    client width.
 *
 * The same probe is used by the negative case, so a broken selector cannot
 * make this suite pass vacuously.
 */
async function containmentViolations(page, cardLocator) {
  const card = await cardLocator.elementHandle();
  return page.evaluate((card) => {
    if (!card) return [{ kind: 'missing-card' }];

    const cardStyle = getComputedStyle(card);
    const padLeft = parseFloat(cardStyle.paddingLeft || '0');
    const padRight = parseFloat(cardStyle.paddingRight || '0');
    const rect = card.getBoundingClientRect();
    const contentLeft = rect.left + padLeft;
    const contentRight = rect.right - padRight;

    const violations = [];

    for (const el of card.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      const style = getComputedStyle(el);
      const tag = el.tagName;
      const cls = String(el.className?.baseVal ?? el.className ?? '').slice(0, 60);
      // Form controls clip their own overflowing text by design, and a box
      // that scrolls or clips its content does not paint outside itself.
      const isControl = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      const clips = style.overflowX !== 'visible';

      if (!clips && !isControl && el.scrollWidth - el.clientWidth > 1) {
        violations.push({
          kind: 'internal-overflow',
          cls,
          tag,
          by: el.scrollWidth - el.clientWidth
        });
      }

      if (!isControl) {
        const over = r.right - contentRight;
        const under = contentLeft - r.left;
        if (over > 1 || under > 1) {
          violations.push({
            kind: 'escapes-card-content-box',
            cls,
            tag,
            over: Math.round(over * 100) / 100,
            under: Math.round(under * 100) / 100
          });
        }
      }
    }

    if (card.scrollWidth - card.clientWidth > 1) {
      violations.push({
        kind: 'card-internal-overflow',
        by: card.scrollWidth - card.clientWidth
      });
    }

    return violations;
  }, card);
}

/** The card's layout box must sit inside its lane's content box. */
async function cardWithinLane(page, cardLocator, laneLocator) {
  const card = await cardLocator.elementHandle();
  const lane = await laneLocator.elementHandle();
  return page.evaluate(
    ({ card, lane }) => {
      if (!card || !lane) return { missing: true };
      const cardRect = card.getBoundingClientRect();
      const laneStyle = getComputedStyle(lane);
      const laneRect = lane.getBoundingClientRect();
      const laneContentLeft = laneRect.left + parseFloat(laneStyle.paddingLeft || '0');
      const laneContentRight = laneRect.right - parseFloat(laneStyle.paddingRight || '0');
      return {
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        laneContentLeft,
        laneContentRight
      };
    },
    { card, lane }
  );
}

/**
 * Wait until the card's transform stops changing.
 *
 * Expanding a card removes its tilt, and the shared card primitive animates
 * that over 150ms. While the animation runs, the card is still a degree or so
 * off vertical — and on the reported task the expanded card is roughly 15 000px
 * tall, so a degree of rotation paints it far outside its own box on the way
 * to upright. The containment contract is about the settled layout, so the
 * assertions measure after the transform has stopped moving.
 */
async function settleCard(page, cardLocator) {
  await cardLocator.evaluate(
    (el) =>
      new Promise((resolve) => {
        let last = null;
        let stableFrames = 0;
        const tick = () => {
          const transform = getComputedStyle(el).transform;
          if (transform === last) {
            stableFrames += 1;
            if (stableFrames >= 3) {
              resolve();
              return;
            }
          } else {
            stableFrames = 0;
            last = transform;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
}

async function expectContained(page, cardLocator, laneLocator, label) {
  const violations = await containmentViolations(page, cardLocator);
  expect(violations, `${label}: card content must stay inside the card`).toEqual([]);

  const geometry = await cardWithinLane(page, cardLocator, laneLocator);
  expect(geometry.missing).toBeFalsy();
  expect(
    geometry.cardRight,
    `${label}: card must not extend past its column`
  ).toBeLessThanOrEqual(geometry.laneContentRight + EPSILON);
  expect(
    geometry.cardLeft,
    `${label}: card must not extend before its column`
  ).toBeGreaterThanOrEqual(geometry.laneContentLeft - EPSILON);
}

for (const viewport of VIEWPORTS) {
  test(`task card content stays inside its column at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seed(page, [makeTask()]);
    await page.goto('/');

    const lane = page.getByTestId('column-acceptance');
    const card = page.getByTestId(`card-${TASK_ID}`);
    await expect(lane).toBeVisible();
    await expect(card).toBeVisible();

    // Collapsed state.
    await expectContained(page, card, lane, `${viewport.name} collapsed`);

    // Expanded / editing state (AC3: the fix applies to both states).
    await page.getByRole('button', { name: '🔧 Add stable app-name hostnames for staging and production' }).first().click();
    await expect(page.locator('.task-card-editor')).toBeVisible();
    await settleCard(page, card);
    await expectContained(page, card, lane, `${viewport.name} expanded`);
  });
}

test('long content on every card surface stays contained at a narrow viewport', async ({ page }) => {
  // AC2 names the surfaces: title, URLs, descriptions, acceptance criteria and
  // workstream content. Each surface carries the longest unbreakable token
  // the reported task contains, one surface per card, so a fix applied to
  // only one surface fails the others.
  const surfaces = [
    { id: 'surface-title-000001', label: 'title', title: `🔧 ${LONG_BRANCH}` },
    { id: 'surface-description01', label: 'description', description: `${LONG_BRANCH}\n\n${LONG_URL}` },
    {
      id: 'surface-acceptance01',
      label: 'acceptance criteria',
      description: `**Acceptance Criteria**\n\n- [ ] AC1: ${LONG_BRANCH}`
    },
    {
      id: 'surface-workstream1',
      label: 'workstream',
      description: `**Workstreams**\n\n- Owner: Rowan\n  Branch: ${LONG_BRANCH}`
    },
    { id: 'surface-url-00000001', label: 'url', description: `Prior work: ${LONG_URL}` }
  ];

  await page.setViewportSize({ width: 1024, height: 800 });
  await seed(
    page,
    surfaces.map((surface) =>
      makeTask({
        id: surface.id,
        title: surface.title ?? '🔧 Add stable app-name hostnames for staging and production',
        description: surface.description ?? REAL_DESCRIPTION
      })
    )
  );
  await page.goto('/');

  const lane = page.getByTestId('column-acceptance');
  await expect(lane).toBeVisible();

  for (const surface of surfaces) {
    const card = page.getByTestId(`card-${surface.id}`);
    await expect(card).toBeVisible();
    await expectContained(page, card, lane, `${surface.label} (collapsed)`);

    await card.getByRole('button').first().click();
    await expect(page.locator('.task-card-editor')).toBeVisible();
    await settleCard(page, card);
    await expectContained(page, card, lane, `${surface.label} (expanded)`);
  }
});

test('the containment probe detects a deliberately overflowing element', async ({ page }) => {
  // The negative case. Without it, a broken selector in the probe would make
  // every assertion above pass vacuously.
  await page.setViewportSize({ width: 1024, height: 800 });
  await seed(page, [makeTask()]);
  await page.goto('/');

  const card = page.getByTestId(`card-${TASK_ID}`);
  await expect(card).toBeVisible();

  const before = await containmentViolations(page, card);
  expect(before, 'the fixture must not overflow before the probe is broken').toEqual([]);

  await page.evaluate((taskId) => {
    const card = document.querySelector(`[data-testid="card-${taskId}"]`);
    const overflower = document.createElement('div');
    overflower.className = 'deliberate-overflow-probe';
    overflower.style.width = '5000px';
    overflower.style.height = '10px';
    card.appendChild(overflower);
  }, TASK_ID);

  const after = await containmentViolations(page, card);
  expect(
    after.some((v) => v.kind === 'escapes-card-content-box'),
    'the probe must report the deliberately overflowing element'
  ).toBe(true);
  expect(
    after.some((v) => v.kind === 'card-internal-overflow'),
    'the probe must report the card as internally overflowing'
  ).toBe(true);
});
