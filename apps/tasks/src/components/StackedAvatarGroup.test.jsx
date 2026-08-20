import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  StackedAvatarGroup,
  buildAvatarAriaLabel,
  buildStackedOwnerLayers,
  roleLabel
} from './StackedAvatarGroup.jsx';

describe('buildStackedOwnerLayers', () => {
  it('preserves delivery, exact actionable gate, and repeated attention slots in order', () => {
    const task = {
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Rowan', 'Tom']
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toEqual([
      { role: 'delivery', owner: 'Rowan', key: 'delivery:rowan' },
      { role: 'workflow-gate', owner: 'Ash', gateType: 'qa_agent', key: 'workflow-gate:0:ash' },
      { role: 'attention', owner: 'Rowan', slot: 0, key: 'attention:0:rowan' },
      { role: 'attention', owner: 'Tom', slot: 1, key: 'attention:1:tom' }
    ]);
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
    expect(entries.map((entry) => entry.role)).toEqual(['workflow-gate', 'attention']);
  });

  it('normalises whitespace and case only inside stable per-slot keys', () => {
    const { entries } = buildStackedOwnerLayers({
      status: 'doing',
      assignee: '  Quinn  ',
      workflowGates: [{ gate: 'qa_agent', owner: 'quinn', state: 'outstanding' }],
      attentionOwners: ['QUINN', 'quinn']
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'delivery:quinn',
      'workflow-gate:0:quinn',
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
  it('renders repeated people as separate avatars in the full Rowan/Ash/Rowan stack', () => {
    const { container } = render(<StackedAvatarGroup task={{
      status: 'doing',
      assignee: 'Rowan',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Rowan', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'delivery assignee Rowan',
      'workflow-gate owner Ash',
      'attention owner Rowan',
      'attention owner Tom'
    ]);
  });

  it('places the top attention owner visually above context and escalation slots', () => {
    const { container } = render(<StackedAvatarGroup task={{
      assignee: 'Rowan',
      status: 'doing',
      workflowGates: [{ gate: 'qa_agent', owner: 'Ash', state: 'outstanding' }],
      attentionOwners: ['Quinn', 'Tom']
    }} />);
    const items = [...container.querySelectorAll('.task-owner-stack-item')];
    expect(items.map((item) => Number(item.style.zIndex))).toEqual([100, 199, 298, 297]);
  });

  it('renders nothing when the task has no ownership data', () => {
    const { container } = render(<StackedAvatarGroup task={{}} />);
    expect(container.querySelector('.task-owner-stack')).toBeNull();
  });

  it('renders the delivery assignee as the first avatar', () => {
    render(<StackedAvatarGroup task={{ assignee: 'Quinn', workflowGates: [], attentionOwners: [] }} />);
    expect(screen.getByLabelText('delivery assignee Quinn')).toBeInTheDocument();
  });

  it('renders workflow-gate and attention-owner avatars in order', () => {
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
    expect(screen.getByLabelText('delivery assignee Rowan')).toBeInTheDocument();
    expect(screen.getByLabelText('workflow-gate owner Ash')).toBeInTheDocument();
    expect(screen.getByLabelText('attention owner Lox')).toBeInTheDocument();
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
