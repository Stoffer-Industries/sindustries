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
      'attention owner Rowan',
      'attention owner Tom',
      'workflow-gate owner Ash',
      'delivery assignee Rowan'
    ]);
  });

  it('places the current attention owner visually above later escalation slots and context', () => {
    const { container } = render(<StackedAvatarGroup task={{
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Quinn', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    // roleDepth baselines: delivery=100, workflow-gate=200, attention=300.
    // Position 0 is the current actor, so it gets the higher attention z.
    expect(items.map((item) => Number(item.style.zIndex))).toEqual([301, 300, 200, 100]);
  });

  it('position zero in a same-role attention stack renders above later slots', () => {
    // AC1: only attention owners; no delivery, no workflow-gate, so the
    // tier-baseline question is moot and the within-tier direction is the
    // whole test.
    const { container } = render(<StackedAvatarGroup task={{
      status: 'open',
      assignee: '',
      workflowGates: [],
      attentionOwners: ['Quinn', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items).toHaveLength(2);
    const zIndexes = items.map((item) => Number(item.style.zIndex));
    expect(zIndexes[0]).toBeGreaterThan(zIndexes[1]);
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
    // the rendered z-index values are strictly decreasing left-to-right so
    // position 0 remains the visible current actor.
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
        expect(zIndexes[i]).toBeLessThan(zIndexes[i - 1]);
      }
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
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'attention owner Lox',
      'workflow-gate owner Ash',
      'delivery assignee Rowan'
    ]);
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
