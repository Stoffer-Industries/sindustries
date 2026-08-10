import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  StackedAvatarGroup,
  buildAvatarAriaLabel,
  buildStackedOwnerLayers,
  roleLabel
} from './StackedAvatarGroup.jsx';

describe('buildStackedOwnerLayers', () => {
  it('returns the delivery assignee as the first layer', () => {
    const task = { assignee: 'Quinn', workflowGates: [], attentionOwners: [] };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toEqual([{ role: 'delivery', owner: 'Quinn', key: 'quinn' }]);
  });

  it('places workflow-gate owners before attention owners', () => {
    const task = {
      assignee: 'Rowan',
      workflowGates: [
        { type: 'tech_design', owner: 'Quinn', state: 'outstanding' },
        { type: 'qa', owner: 'Tom', state: 'outstanding' }
      ],
      attentionOwners: ['Lox']
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toEqual([
      { role: 'delivery', owner: 'Rowan', key: 'rowan' },
      { role: 'workflow-gate', owner: 'Quinn', gateType: 'tech_design', key: 'quinn' },
      { role: 'workflow-gate', owner: 'Tom', gateType: 'qa', key: 'tom' },
      { role: 'attention', owner: 'Lox', key: 'lox' }
    ]);
  });

  it('skips approved workflow gates', () => {
    const task = {
      assignee: 'Rowan',
      workflowGates: [
        { type: 'tech_design', owner: 'Quinn', state: 'approved' },
        { type: 'qa', owner: 'Tom', state: 'outstanding' }
      ],
      attentionOwners: []
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ role: 'workflow-gate', owner: 'Tom', gateType: 'qa', key: 'tom' });
  });

  it('skips workflow gates without an owner', () => {
    const task = {
      assignee: 'Rowan',
      workflowGates: [
        { type: 'tech_design', owner: null, state: 'outstanding' },
        { type: 'qa', owner: 'Tom', state: 'outstanding' }
      ],
      attentionOwners: []
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toHaveLength(2);
    expect(entries[1].owner).toBe('Tom');
  });

  it('deduplicates people visually while preserving the first-seen role', () => {
    const task = {
      assignee: 'Quinn',
      workflowGates: [{ type: 'qa', owner: 'Quinn', state: 'outstanding' }],
      attentionOwners: ['quinn']
    };
    const { entries, roleCounts } = buildStackedOwnerLayers(task);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('delivery');
    expect(roleCounts.get('quinn')).toBe(3);
  });

  it('returns empty layers when the task has no ownership data', () => {
    const { entries, roleCounts } = buildStackedOwnerLayers({});
    expect(entries).toEqual([]);
    expect(roleCounts.size).toBe(0);
  });

  it('renders the workflow-gate and attention-owner layers even when the assignee is empty', () => {
    const task = {
      assignee: null,
      workflowGates: [{ type: 'qa', owner: 'Tom', state: 'outstanding' }],
      attentionOwners: ['Lox']
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('workflow-gate');
    expect(entries[1].role).toBe('attention');
  });

  it('normalises whitespace and case for the dedupe key', () => {
    const task = {
      assignee: '  Quinn  ',
      workflowGates: [{ type: 'qa', owner: 'quinn', state: 'outstanding' }],
      attentionOwners: ['QUINN']
    };
    const { entries } = buildStackedOwnerLayers(task);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('quinn');
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
    const entry = { role: 'delivery', owner: 'Quinn', key: 'quinn' };
    const roleCounts = new Map([['quinn', 1]]);
    expect(buildAvatarAriaLabel(entry, roleCounts)).toBe('delivery assignee Quinn');
  });

  it('notes the additional roles when the person wears multiple hats', () => {
    const entry = { role: 'delivery', owner: 'Quinn', key: 'quinn' };
    const roleCounts = new Map([['quinn', 2]]);
    expect(buildAvatarAriaLabel(entry, roleCounts)).toBe(
      'delivery assignee Quinn (also has other roles on this task)'
    );
  });
});

describe('StackedAvatarGroup', () => {
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
      workflowGates: [{ type: 'qa', owner: 'Tom', state: 'outstanding' }],
      attentionOwners: ['Lox']
    };
    render(<StackedAvatarGroup task={task} />);
    // The Avatar component renders an <img> when the user has an avatarSrc,
    // so the initial text is not in the DOM. Check by aria-label instead,
    // which is the source of truth for the role semantics (AC5, AC6).
    expect(screen.getByLabelText('delivery assignee Rowan')).toBeInTheDocument();
    expect(screen.getByLabelText('workflow-gate owner Tom')).toBeInTheDocument();
    expect(screen.getByLabelText('attention owner Lox')).toBeInTheDocument();
  });

  it('marks the visible avatar with the correct data-role attribute', () => {
    const task = {
      assignee: 'Rowan',
      workflowGates: [{ type: 'qa', owner: 'Tom', state: 'outstanding' }],
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
      workflowGates: [
        { type: 'tech_design', owner: 'Quinn', state: 'approved' },
        { type: 'qa', owner: 'Tom', state: 'outstanding' }
      ],
      attentionOwners: []
    };
    render(<StackedAvatarGroup task={task} />);
    // Quinn is the approved gate owner — she should not appear in the
    // stack because the handoff is satisfied. Tom is still outstanding.
    expect(screen.getByLabelText('delivery assignee Rowan')).toBeInTheDocument();
    expect(screen.getByLabelText('workflow-gate owner Tom')).toBeInTheDocument();
    expect(screen.queryByLabelText('workflow-gate owner Quinn')).toBeNull();
  });

  it('renders the avatar even when the workflow-gate owner is unknown / free-form', () => {
    const task = {
      assignee: 'Rowan',
      workflowGates: [{ type: 'qa', owner: 'someone-unknown', state: 'outstanding' }],
      attentionOwners: []
    };
    render(<StackedAvatarGroup task={task} />);
    expect(screen.getByLabelText('workflow-gate owner someone-unknown')).toBeInTheDocument();
  });
});
