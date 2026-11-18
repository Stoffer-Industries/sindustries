import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TaskEditor } from '../components/TaskEditor.jsx';

const defaultProps = {
  draft: {
    title: 'Test Task',
    description: 'Test description',
    status: 'ready',
    priority: 'medium',
    assignee: '',
    dueAt: '',
    tagsText: '',
    taskType: '',
    blocked: false
  },
  task: {
    id: 1,
    title: 'Test Task',
    comments: []
  },
  isDirty: false,
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
  onPatch: vi.fn(),
  onArchive: vi.fn(),
  onClose: vi.fn(),
  onAddComment: vi.fn(),
  onFetchDependency: vi.fn(),
  onUpdateDependencies: vi.fn(),
  onOpenTask: vi.fn(),
  isSubmittingComment: false
};

describe('TaskEditor', () => {
  /**
   * Acceptance-criteria rows in the description preview. `marked` v17 emits no
   * class on task-list items, so a row is matched by the checkbox it owns.
   */
  function acceptanceCriteriaRows() {
    return Array.from(document.querySelectorAll('.description-preview li')).filter((li) =>
      li.querySelector('input[type="checkbox"]')
    );
  }

  it('renders task title', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByLabelText('Detail title')).toHaveValue('Test Task');
  });

  it('renders attention-owner reasons and management controls in the detail view', async () => {
    const props = {
      ...defaultProps,
      task: {
        ...defaultProps.task,
        attentionOwnerDetails: [
          {
            id: 'attention-1',
            owner: 'Quinn',
            position: 0,
            addedBy: 'Tom',
            note: 'Needs UI verification before acceptance.',
            createdAt: '2026-10-07T00:00:00.000Z'
          }
        ]
      }
    };

    render(<TaskEditor {...props} />);

    expect(await screen.findByRole('region', { name: 'Attention owners' })).toBeInTheDocument();
    expect(screen.getByText('Needs UI verification before acceptance.')).toBeInTheDocument();
    expect(screen.getByText('Reason (required)')).toBeInTheDocument();
    expect(screen.getByTestId('composer-submit')).toBeDisabled();
  });

  it('renders description in view mode by default', () => {
    render(<TaskEditor {...defaultProps} />);
    // View mode shows rendered markdown, not a textarea
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
  });

  it('switches to edit mode when description preview is clicked', () => {
    render(<TaskEditor {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    expect(screen.getByLabelText('Detail description')).toHaveValue('Test description');
  });

  it('switches back to preview mode when description loses focus', () => {
    render(<TaskEditor {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    fireEvent.blur(screen.getByLabelText('Detail description'));
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
  });

  it('switches to edit mode when clicking description preview', () => {
    render(<TaskEditor {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    expect(screen.getByLabelText('Detail description')).toBeInTheDocument();
  });

  it('renders empty description placeholder', () => {
    const props = { ...defaultProps, draft: { ...defaultProps.draft, description: '' } };
    render(<TaskEditor {...props} />);
    expect(screen.getByText('No description. Click to add one.')).toBeInTheDocument();
  });

  it('renders markdown in description view mode', () => {
    const props = { ...defaultProps, draft: { ...defaultProps.draft, description: '**bold** and *italic*' } };
    render(<TaskEditor {...props} />);
    const rendered = screen.getByRole('button', { name: 'Click to edit description' });
    expect(rendered.innerHTML).toContain('<strong>bold</strong>');
    expect(rendered.innerHTML).toContain('<em>italic</em>');
  });

  it('toggles markdown checkboxes in description preview and persists the patch', async () => {
    const onDraftChange = vi.fn();
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, description: '- [ ] first\n- [x] second' }}
        onDraftChange={onDraftChange}
        onPatch={onPatch}
      />
    );

    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        expect.objectContaining({ description: '- [x] first\n- [x] second' })
      );
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ description: '- [x] first\n- [x] second' })
      );
    });
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
  });

  it('toggles the acceptance criterion when its row text is clicked and stays in preview mode', async () => {
    const onDraftChange = vi.fn();
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, description: '- [ ] first AC\n- [x] second AC' }}
        onDraftChange={onDraftChange}
        onPatch={onPatch}
      />
    );

    const rows = acceptanceCriteriaRows();
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);

    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        expect.objectContaining({ description: '- [x] first AC\n- [x] second AC' })
      );
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ description: '- [x] first AC\n- [x] second AC' })
      );
    });
    // The mis-click must not enter inline text edit mode.
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
  });

  it('resolves a row click to that row’s own criterion', async () => {
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, description: '- [ ] first AC\n- [x] second AC' }}
        onPatch={onPatch}
      />
    );

    const rows = acceptanceCriteriaRows();
    fireEvent.click(rows[1]);

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith(
        expect.objectContaining({ description: '- [ ] first AC\n- [ ] second AC' })
      );
    });
  });

  it('does not enter edit mode when a URL is cmd-clicked and keeps the browser default', () => {
    const { container } = render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, description: 'See [the spec](#spec).' }}
      />
    );

    const link = document.querySelector('.description-preview a[href]');
    expect(link).toBeTruthy();

    // React delegates to the root container, and the RTL container IS that
    // root, so a listener here runs after React's handler and reads the real
    // `defaultPrevented` state.
    const seen = [];
    const listener = (event) => seen.push(event.defaultPrevented);
    container.addEventListener('click', listener);
    try {
      fireEvent.click(link, { metaKey: true });
    } finally {
      container.removeEventListener('click', listener);
    }

    expect(seen).toEqual([false]);
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
  });

  it('opens a link inside an acceptance-criteria row without toggling the criterion', () => {
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, description: '- [ ] AC with a [link](#row-link) inside' }}
        onPatch={onPatch}
      />
    );

    const link = document.querySelector('.description-preview li a[href]');
    expect(link).toBeTruthy();
    fireEvent.click(link);

    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
  });

  it('enters description edit mode through the explicit Edit control', () => {
    render(<TaskEditor {...defaultProps} />);

    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.getByLabelText('Detail description')).toHaveValue('Test description');
  });

  it('still enters edit mode on plain text when the card sits inside a list item', async () => {
    // A task card is rendered inside a backlog <li>. The classifier must scope
    // its row lookup to the markdown, or a plain-text click resolves to that
    // outer <li>, finds a checkbox and toggles an acceptance criterion
    // instead of entering edit mode.
    const onPatch = vi.fn().mockResolvedValue(true);
    render(
      <ul>
        <li>
          <TaskEditor
            {...defaultProps}
            draft={{ ...defaultProps.draft, description: 'Plain paragraph.\n\n- [ ] first AC' }}
            onPatch={onPatch}
          />
        </li>
      </ul>
    );

    const paragraph = document.querySelector('.description-preview p');
    expect(paragraph).toBeTruthy();
    fireEvent.click(paragraph);

    expect(screen.getByLabelText('Detail description')).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('leaves description edit mode through the explicit Done control', () => {
    render(<TaskEditor {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.getByLabelText('Detail description')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done editing description' }));
    expect(screen.queryByLabelText('Detail description')).not.toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
  });

  it('renders status select', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByLabelText('Detail status')).toHaveValue('ready');
  });

  it('renders priority select', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByLabelText('Detail priority')).toHaveValue('medium');
  });

  it('calls onDraftChange when title changes', () => {
    const onDraftChange = vi.fn();
    render(<TaskEditor {...defaultProps} onDraftChange={onDraftChange} />);

    const titleInput = screen.getByLabelText('Detail title');
    fireEvent.change(titleInput, { target: { value: 'New Title' } });

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New Title' })
    );
  });

  it('calls onDraftChange when description changes in edit mode', () => {
    const onDraftChange = vi.fn();
    render(<TaskEditor {...defaultProps} onDraftChange={onDraftChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Click to edit description' }));
    const descInput = screen.getByLabelText('Detail description');
    fireEvent.change(descInput, { target: { value: 'Updated description' } });

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Updated description' })
    );
  });

  it('calls onSave when save button clicked', () => {
    const onSave = vi.fn();
    render(<TaskEditor {...defaultProps} onSave={onSave} />);

    fireEvent.click(screen.getByText('Save changes'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Task',
        description: 'Test description'
      })
    );
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<TaskEditor {...defaultProps} onClose={onClose} />);

    const closeButtons = screen.getAllByText('Close');
    fireEvent.click(closeButtons[1]);

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the view card is clicked', () => {
    const onClose = vi.fn();
    render(<TaskEditor {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close task editor and show card view' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('renders the saved task in the view card preview', () => {
    render(
      <TaskEditor
        {...defaultProps}
        draft={{ ...defaultProps.draft, title: 'Draft title' }}
        task={{ ...defaultProps.task, title: 'Saved title', priority: 'high' }}
      />
    );

    expect(screen.getByRole('button', { name: 'Close task editor and show card view' })).toHaveTextContent('Saved title');
    expect(screen.getByLabelText('Detail title')).toHaveValue('Draft title');
  });

  it('calls onArchive when archive button clicked', () => {
    const onArchive = vi.fn();
    render(<TaskEditor {...defaultProps} onArchive={onArchive} />);

    fireEvent.click(screen.getByText('Archive task'));

    expect(onArchive).toHaveBeenCalled();
  });

  it('renders blocked checkbox', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByLabelText('Detail blocked')).not.toBeChecked();
  });

  it('shows comments section', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByText('Comments')).toBeInTheDocument();
  });

  it('shows no comments message when empty', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByText('No comments yet')).toBeInTheDocument();
  });

  it('displays comments when present', () => {
    const propsWithComments = {
      ...defaultProps,
      task: {
        id: 1,
        title: 'Test Task',
        comments: [
          { id: 1, author: 'John', text: 'Great work!', createdAt: '2024-01-15T10:00:00Z' }
        ]
      }
    };
    render(<TaskEditor {...propsWithComments} />);

    expect(screen.getByText('John')).toBeInTheDocument();
    expect(screen.getByText('Great work!')).toBeInTheDocument();
  });

  it('renders markdown in comments', () => {
    const propsWithComments = {
      ...defaultProps,
      task: {
        id: 1,
        title: 'Test Task',
        comments: [
          { id: 1, author: 'John', text: '**bold** text', createdAt: '2024-01-15T10:00:00Z' }
        ]
      }
    };
    render(<TaskEditor {...propsWithComments} />);

    const commentBody = screen.getByLabelText('Task comments').querySelector('.comment-body');
    expect(commentBody.innerHTML).toContain('<strong>bold</strong>');
  });

  it('can toggle comment composer', () => {
    render(<TaskEditor {...defaultProps} />);

    // Click the Comment button to open comment composer
    const toggleBtn = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(toggleBtn);

    expect(screen.getByLabelText('Comment author')).toBeInTheDocument();
    expect(screen.getByLabelText('Comment text')).toBeInTheDocument();
  });

  it('renders tags input', () => {
    const propsWithTags = {
      ...defaultProps,
      draft: { ...defaultProps.draft, tagsText: 'ui, api' }
    };
    render(<TaskEditor {...propsWithTags} />);

    expect(screen.getByLabelText('Detail tags')).toHaveValue('ui, api');
  });

  it('renders assignee input', () => {
    const propsWithAssignee = {
      ...defaultProps,
      draft: { ...defaultProps.draft, assignee: 'Rowan' }
    };
    render(<TaskEditor {...propsWithAssignee} />);

    expect(screen.getByLabelText('Detail assignee')).toHaveValue('Rowan');
  });

  it('renders task type selector and saves taskType', () => {
    const onSave = vi.fn();
    const props = {
      ...defaultProps,
      draft: { ...defaultProps.draft, taskType: 'feature' },
      onSave
    };
    render(<TaskEditor {...props} />);

    expect(screen.getByLabelText('Detail task type')).toHaveValue('feature');
    expect(screen.getByRole('option', { name: 'Feature' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save changes'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'feature' })
    );
  });

  it('renders dependency links with title and status', () => {
    render(
      <TaskEditor
        {...defaultProps}
        task={{
          ...defaultProps.task,
          dependsOn: [{ id: 'dep-1', title: 'Upstream API work', status: 'done' }],
          dependsOnIds: ['dep-1']
        }}
      />
    );

    const dependencies = screen.getByRole('region', { name: 'Task dependencies' });
    expect(within(dependencies).getByRole('button', { name: /Upstream API work\s*Done/ })).toBeInTheDocument();
    expect(within(dependencies).getByText('Done')).toBeInTheDocument();
  });

  it('validates a dependency ID and confirms before adding it', async () => {
    const onFetchDependency = vi.fn().mockResolvedValue({
      id: 'dep-2',
      title: 'Dependency task',
      status: 'ready'
    });
    const onUpdateDependencies = vi.fn().mockResolvedValue(true);

    render(
      <TaskEditor
        {...defaultProps}
        task={{ ...defaultProps.task, id: 'task-1', dependsOn: [], dependsOnIds: [] }}
        onFetchDependency={onFetchDependency}
        onUpdateDependencies={onUpdateDependencies}
      />
    );

    fireEvent.change(screen.getByLabelText('Dependency task ID'), { target: { value: 'dep-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    expect(await screen.findByText('Dependency task')).toBeInTheDocument();
    expect(within(screen.getByRole('status')).getByText('Ready')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(onUpdateDependencies).toHaveBeenCalledWith(['dep-2']);
    });
  });

  it('shows an inline error when dependency lookup fails', async () => {
    const onFetchDependency = vi.fn().mockRejectedValue(new Error('Task not found'));

    render(
      <TaskEditor
        {...defaultProps}
        task={{ ...defaultProps.task, id: 'task-1', dependsOn: [], dependsOnIds: [] }}
        onFetchDependency={onFetchDependency}
      />
    );

    fireEvent.change(screen.getByLabelText('Dependency task ID'), { target: { value: 'missing-task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Task not found');
  });

  it('removes one dependency without clearing the rest', async () => {
    const onUpdateDependencies = vi.fn().mockResolvedValue(true);

    render(
      <TaskEditor
        {...defaultProps}
        task={{
          ...defaultProps.task,
          dependsOn: [
            { id: 'dep-1', title: 'First dependency', status: 'ready' },
            { id: 'dep-2', title: 'Second dependency', status: 'doing' }
          ],
          dependsOnIds: ['dep-1', 'dep-2']
        }}
        onUpdateDependencies={onUpdateDependencies}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove dependency First dependency' }));

    await waitFor(() => {
      expect(onUpdateDependencies).toHaveBeenCalledWith(['dep-2']);
    });
  });
});
