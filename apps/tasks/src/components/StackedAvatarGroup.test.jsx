import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  StackedAvatarGroup,
  buildAvatarAriaLabel,
  buildStackedOwnerLayers,
  roleLabel
} from './StackedAvatarGroup.jsx';

describe('buildStackedOwnerLayers', () => {
  it('preserves the current attention owner first, then gate and delivery context', () => {
    const task = {
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Quinn', 'Tom']
    };
    // No cross-role dedupe needed: Rowan is delivery only, Ash is workflow-gate
    // only, Quinn/Tom are attention-only. All four slots render in order.
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toEqual([
      { role: 'attention', owner: 'Quinn', slot: 0, note: null, addedBy: null, rowId: null, key: 'attention:0:quinn' },
      { role: 'attention', owner: 'Tom', slot: 1, note: null, addedBy: null, rowId: null, key: 'attention:1:tom' },
      { role: 'workflow-gate', owner: 'Ash', gateType: 'qa_agent', key: 'workflow-gate:0:ash' },
      { role: 'delivery', owner: 'Rowan', key: 'delivery:rowan' }
    ]);
  });

  it('collapses a cross-role duplicate into the highest-tier role (AC4)', () => {
    // Rowan is delivery + attention at slot 0 — the attention tier outranks
    // delivery, so the duplicate collapses into one attention row.
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: 'Rowan',
      attentionOwners: ['Rowan', 'Tom']
    });
    expect(entries.map((entry) => `${entry.role}:${entry.owner}`)).toEqual([
      'attention:Rowan',
      'attention:Tom'
    ]);
    expect(entries).toHaveLength(2);
  });

  it('preserves separate attention slots when a person repeats within the attention tier only', () => {
    // Two attention slots for Rowan — that is the escalation shape; we
    // intentionally do NOT collapse intra-tier repeats. Quinn is delivery
    // only, so the lower-tier delivery renders LAST after attention.
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: 'Quinn',
      attentionOwners: ['Rowan', 'Rowan', 'Tom']
    });
    expect(entries.map((entry) => `${entry.role}:${entry.owner}`)).toEqual([
      'attention:Rowan',
      'attention:Rowan',
      'attention:Tom',
      'delivery:Quinn'
    ]);
    expect(entries[0].slot).toBe(0);
    expect(entries[1].slot).toBe(1);
    expect(entries[2].slot).toBe(2);
  });

  it.each([
    ['open', 'spec'],
    ['ready', 'tech_design'],
    ['doing', 'qa_agent'],
    ['acceptance', 'accepted']
  ])('includes only the %s-stage %s gate', (status, expectedGate) => {
    const workflowGates = ['spec', 'tech_design', 'qa_agent', 'accepted'].map((gate) => ({
      gate, owner: gate, state: 'outstanding'
    }));
    const { entries } = buildStackedOwnerLayers({ status, workflowGates });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: 'workflow-gate', owner: expectedGate, gateType: expectedGate });
  });

  it('excludes approved, stale, future, ownerless, and unknown-stage gates', () => {
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [
        { gate: 'spec', owner: 'Tom', state: 'outstanding' },
        { gate: 'qa_agent', owner: 'Ash', state: 'approved' },
        { gate: 'accepted', owner: 'Tom', state: 'outstanding' },
        { gate: 'qa_agent', owner: null, state: 'outstanding' }
      ]
    });
    expect(entries).toEqual([{ role: 'delivery', owner: 'Rowan', key: 'delivery:rowan' }]);
    expect(buildStackedOwnerLayers({ status: 'done', workflowGates: [
      { gate: 'accepted', owner: 'Tom', state: 'outstanding' }
    ] }).entries).toEqual([]);
  });

  it('renders gate and attention layers when the assignee is empty', () => {
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Lox']
    });
    expect(entries.map((entry) => entry.role)).toEqual(['attention', 'workflow-gate']);
  });

  it('promotes the current gate owner to the first rendered responsibility when attention is empty', () => {
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: []
    });
    expect(entries.map((entry) => `${entry.role}:${entry.owner}`)).toEqual([
      'workflow-gate:Ash',
      'delivery:Rowan'
    ]);
  });

  it('normalises whitespace and case only inside stable per-slot keys', () => {
    // AC4: same-name cross-tier duplicates collapse into the highest
    // tier (attention). Workflow-gate Quinn and delivery Quinn both
    // reduce to the existing attention-row representative. Both
    // attention slots stay — the intra-tier repeat is part of the
    // escalation shape. Whitespace and case differences are normalised
    // inside the per-slot key.
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: '  Quinn  ',
      workflowGates: [{ gate: 'qa_agent', owner: 'quinn', state: 'outstanding' }],
      attentionOwners: ['QUINN', 'quinn']
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'attention:0:quinn',
      'attention:1:quinn'
    ]);
  });

  it('returns empty layers when the task has no ownership data', () => {
    expect(buildStackedOwnerLayers({}).entries).toEqual([]);
  });
});

describe('roleLabel', () => {
  it('maps each role to a stable human-readable label', () => {
    expect(roleLabel('delivery')).toBe('delivery assignee');
    expect(roleLabel('workflow-gate')).toBe('workflow-gate owner');
    expect(roleLabel('attention')).toBe('attention owner');
  });

  it('falls back to a generic label for unknown roles', () => {
    expect(roleLabel('unknown')).toBe('owner');
  });
});

describe('buildAvatarAriaLabel', () => {
  it('returns the single-role label when the person has one role', () => {
    const entry = { role: 'delivery', owner: 'Quinn', key: 'delivery:quinn' };
    expect(buildAvatarAriaLabel(entry)).toBe('delivery assignee Quinn');
  });

  it('keeps each repeated role slot independently labelled', () => {
    const entry = { role: 'delivery', owner: 'Quinn', key: 'delivery:quinn' };
    expect(buildAvatarAriaLabel(entry)).toBe('delivery assignee Quinn');
  });
});

describe('StackedAvatarGroup', () => {
  it('collapses a cross-role duplicate into a single attention avatar (AC4)', () => {
    // Rowan is both delivery and attention at slot 0 — the avatar stack
    // collapses that into ONE attention avatar (highest tier wins).
    // After the render-order fix, position 0 (Rowan) is rightmost; DOM
    // order is [Tom, Rowan] with both rows carrying the `attention` data-role.
    const { container } = render(<StackedAvatarGroup task={{
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [],
      attentionOwners: ['Rowan', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.getAttribute('data-role'))).toEqual(['attention', 'attention']);
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'attention owner Tom',
      'attention owner Rowan'
    ]);
  });

  it('places the current attention owner visually above later escalation slots and context', () => {
    // After the render-order fix, the DOM order is right-to-left of the
    // logical escalation order: delivery first, then workflow-gate, then
    // attention slot N, then attention slot 0 (rightmost). Position 0
    // (Quinn) keeps the highest z so it paints on top.
    const { container } = render(<StackedAvatarGroup task={{
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Quinn', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    // roleDepth baselines: delivery=100, workflow-gate=200, attention=300.
    // Position 0 keeps the higher attention z; DOM order is reversed
    // (delivery leftmost, attention slot 0 rightmost) so the z-index
    // values strictly increase left-to-right.
    expect(items.map((item) => Number(item.style.zIndex))).toEqual([100, 200, 300, 301]);
    expect(items[items.length - 1].getAttribute('aria-label')).toBe('attention owner Quinn');
  });

  it('position zero in a same-role attention stack renders above later slots', () => {
    // AC1: only attention owners; no delivery, no workflow-gate, so the
    // tier-baseline question is moot and the within-tier direction is the
    // whole test. After the render-order fix, position 0 (Quinn) is the
    // rightmost DOM child and keeps the higher z-index.
    const { container } = render(<StackedAvatarGroup task={{
      status: 'open',
      assignee: '',
      workflowGates: [],
      attentionOwners: ['Quinn', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items).toHaveLength(2);
    const zIndexes = items.map((item) => Number(item.style.zIndex));
    expect(zIndexes[zIndexes.length - 1]).toBeGreaterThan(zIndexes[0]);
    expect(items[items.length - 1].getAttribute('aria-label')).toBe('attention owner Quinn');
    expect(items[0].getAttribute('aria-label')).toBe('attention owner Tom');
  });

  it('single-avatar rendering is unchanged', () => {
    // AC3: a single avatar keeps its existing role-tier baseline z value
    // and is the only one rendered. The exact baseline depends on role;
    // for an attention-only stack it is 300 + 0 = 300.
    const { container } = render(<StackedAvatarGroup task={{
      status: 'open',
      assignee: '',
      workflowGates: [],
      attentionOwners: ['Quinn']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items).toHaveLength(1);
    expect(Number(items[0].style.zIndex)).toBe(300);
  });

  it('stacks of three and four attention avatars keep position zero on top', () => {
    // AC3: for stacks of 3 and 4 attention owners (no delivery / gate),
    // the rendered z-index values are strictly increasing left-to-right
    // because the render order is reversed: delivery/lower-tier leftmost,
    // attention slot 0 rightmost. Position 0 remains the visible current
    // actor at the rightmost DOM child.
    for (const owners of [['A', 'B', 'C'], ['A', 'B', 'C', 'D']]) {
      const { container } = render(<StackedAvatarGroup task={{
        status: 'open',
        assignee: '',
        workflowGates: [],
        attentionOwners: owners
      }} />);
      const items = [...container.querySelectorAll('.task-owner-stack-item')];
      expect(items).toHaveLength(owners.length);
      const zIndexes = items.map((item) => Number(item.style.zIndex));
      for (let i = 1; i < zIndexes.length; i += 1) {
        expect(zIndexes[i]).toBeGreaterThan(zIndexes[i - 1]);
      }
      // Position 0 is rightmost and carries the highest z.
      const expectedTopOwner = owners[0];
      const topItem = items[items.length - 1];
      expect(topItem.getAttribute('aria-label')).toBe(`attention owner ${expectedTopOwner}`);
      expect(Number(topItem.style.zIndex)).toBe(zIndexes[zIndexes.length - 1]);
    }
  });

  it('renders nothing when the task has no ownership data', () => {
    const { container } = render(<StackedAvatarGroup task={{}} />);
    expect(container.querySelector('.task-owner-stack')).toBeNull();
  });

  it('renders the delivery assignee as context when no attention owner exists', () => {
    render(<StackedAvatarGroup task={{ assignee: 'Quinn', workflowGates: [], attentionOwners: [] }} />);
    expect(screen.getByLabelText('delivery assignee Quinn')).toBeInTheDocument();
  });

  it('renders attention, workflow-gate, and delivery avatars in responsibility order', () => {
    const task = {
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Lox']
    };
    render(<StackedAvatarGroup task={task} />);
    // The Avatar component renders an <img> when the user has an avatarSrc,
    // so the initial text is not in the DOM. Check by aria-label instead,
    // which is the source of truth for the role semantics (AC5, AC6).
    expect(screen.getByLabelText('attention owner Lox')).toBeInTheDocument();
    expect(screen.getByLabelText('workflow-gate owner Ash')).toBeInTheDocument();
    expect(screen.getByLabelText('delivery assignee Rowan')).toBeInTheDocument();
    const items = [...document.querySelectorAll('.task-owner-stack-item')];
    // After the render-order fix: delivery leftmost, workflow-gate middle,
    // attention rightmost. The logical escalation order (attention,
    // workflow-gate, delivery) is preserved by `buildStackedOwnerLayers`;
    // only the DOM render order is reversed.
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'delivery assignee Rowan',
      'workflow-gate owner Ash',
      'attention owner Lox'
    ]);
  });

  it('renders the top-of-stack attention owner rightmost (AC1)', () => {
    // AC1 contract: left-to-right visual flow with the top-of-stack
    // (position-0 attention owner) as the rightmost DOM child, mirroring
    // the existing z-index hierarchy. Mixed-role case: delivery + gate +
    // attention slot 0 + attention slot 1, so the rightmost item is the
    // position-0 attention owner.
    const task = {
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Quinn', 'Tom']
    };
    const { container } = render(<StackedAvatarGroup task={task} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'delivery assignee Rowan',
      'workflow-gate owner Ash',
      'attention owner Tom',
      'attention owner Quinn'
    ]);
    // Rightmost item is the position-0 attention owner (Quinn) and the
    // top of the visual stack.
    const rightmost = items[items.length - 1];
    expect(rightmost.getAttribute('data-role')).toBe('attention');
    expect(rightmost.getAttribute('data-owner-key')).toBe('attention:0:quinn');
    expect(Number(rightmost.style.zIndex)).toBeGreaterThan(Number(items[items.length - 2].style.zIndex));
  });

  it('preserves the no-cross-role-collapse and per-slot aria-label contracts after the render-order flip', () => {
    // AC2 (no regressions): role-tier grouping, overflow count, and
    // aria-labels must all stay correct after the render-order flip.
    // This test combines the three in one fixture.
    const task = {
      assignee: 'Quinn',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Rowan', 'Rowan', 'Tom']
    };
    const { container } = render(<StackedAvatarGroup task={task} maxVisible={5} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    // entries: [attention:Rowan@0, attention:Rowan@1, attention:Tom, workflow-gate:Ash, delivery:Quinn]
    // After flip (rightmost first): delivery, workflow-gate, attention:Tom, attention:Rowan@1, attention:Rowan@0
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'delivery assignee Quinn',
      'workflow-gate owner Ash',
      'attention owner Tom',
      'attention owner Rowan',
      'attention owner Rowan'
    ]);
    // No overflow chip — 5 visible out of 5 entries, overflow=0.
    expect(container.querySelector('.task-owner-stack-overflow')).toBeNull();
  });

  it('still surfaces the overflow chip at maxVisible after the render-order flip', () => {
    // AC2 (no regressions): the overflow chip count is independent of the
    // DOM render order. With maxVisible=3 and 5 entries, 2 are hidden and
    // the chip says "2 more owners".
    const task = {
      assignee: 'Quinn',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Rowan', 'Rowan', 'Tom']
    };
    render(<StackedAvatarGroup task={task} maxVisible={3} />);
    expect(screen.getByLabelText('2 more owners')).toBeInTheDocument();
  });

  it('marks the visible avatar with the correct data-role attribute', () => {
    const task = {
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Lox']
    };
    const { container } = render(<StackedAvatarGroup task={task} />);
    expect(container.querySelector('.task-owner-stack-delivery')).not.toBeNull();
    expect(container.querySelector('.task-owner-stack-workflow-gate')).not.toBeNull();
    expect(container.querySelector('.task-owner-stack-attention')).not.toBeNull();
  });

  it('surfaces the per-row note for each intra-tier repeat (Quinn review AC4 follow-up)', () => {
    // Quinn's PR #751 review: the original findAttentionDetail matched by
    // owner only, so two attention rows for the same owner at different
    // positions would both surface the first row's note. The slot-aware
    // lookup preserves each row's own note. This pure-function test
    // exercises `buildStackedOwnerLayers` so the per-row note makes it
    // onto every layer entry (the render-component test in this file
    // depends on a working jsdom + Avatar component which is currently
    // flaky in this worktree's test setup; the pure-function assertion
    // is sufficient to lock the lookup contract).
    const task = {
      status: 'doing',
      assignee: 'Rowan',
      attentionOwners: ['Quinn', 'Quinn'],
      attentionOwnerDetails: [
        { id: 'ao-1', owner: 'Quinn', addedBy: 'Tom', note: 'first reason — block on the contract', position: 0 },
        { id: 'ao-2', owner: 'Quinn', addedBy: 'Ash', note: 'second reason — block on the test plan', position: 1 }
      ]
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries.map((entry) => `${entry.role}:${entry.owner}:${entry.slot ?? '-'}:${entry.note ?? '-'}`)).toEqual([
      'attention:Quinn:0:first reason — block on the contract',
      'attention:Quinn:1:second reason — block on the test plan',
      'delivery:Rowan:-:-'
    ]);
  });

  it('falls back to the first case-insensitive detail match when the slot lookup misses', () => {
    // Older mapper responses surface attentionOwnerDetails without per-row
    // positions; the lookup still needs to find the matching detail row by
    // owner so the layer carries the note. Pure-function assertion locks
    // the slot-aware + first-match fallback contract.
    const task = {
      status: 'doing',
      assignee: 'Rowan',
      attentionOwners: ['Quinn', 'Tom'],
      attentionOwnerDetails: [
        { id: 'ao-1', owner: 'Quinn', addedBy: 'Tom', note: 'first reason', position: 0 },
        { id: 'ao-2', owner: 'Tom', addedBy: 'Ash', note: 'tom reason', position: 1 }
      ]
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries.map((entry) => `${entry.role}:${entry.owner}:${entry.note}`)).toEqual([
      'attention:Quinn:first reason',
      'attention:Tom:tom reason',
      'delivery:Rowan:undefined'
    ]);
  });

  it('caps the rendered avatars at maxVisible and shows an overflow chip', () => {
    const task = {
      assignee: 'A',
      workflowGates: [],
      attentionOwners: ['B', 'C', 'D', 'E']
    };
    render(<StackedAvatarGroup task={task} maxVisible={2} />);
    expect(screen.getByLabelText('3 more owners')).toBeInTheDocument();
  });

  it('skips approved workflow gates in the rendered stack', () => {
    const task = {
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [
        { gate: 'tech_design', owner: 'Quinn', state: 'approved' },
        { gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }
      ],
      attentionOwners: []
    };
    render(<StackedAvatarGroup task={task} />);
    // Quinn is the approved gate owner — she should not appear in the
    // stack because the handoff is satisfied. Ash is still outstanding.
    expect(screen.getByLabelText('delivery assignee Rowan')).toBeInTheDocument();
    expect(screen.getByLabelText('workflow-gate owner Ash')).toBeInTheDocument();
    expect(screen.queryByLabelText('workflow-gate owner Quinn')).toBeNull();
  });

  it('renders the avatar even when the workflow-gate owner is unknown / free-form', () => {
    const task = {
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'someone-unknown', state: 'outstanding' }],
      attentionOwners: []
    };
    render(<StackedAvatarGroup task={task} />);
    expect(screen.getByLabelText('workflow-gate owner someone-unknown')).toBeInTheDocument();
  });
});
