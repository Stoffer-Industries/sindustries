import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  onArchive: vi.fn(),
  onClose: vi.fn(),
  onAddComment: vi.fn(),
  isSubmittingComment: false
};

describe('TaskEditor', () => {
  it('renders task title', () => {
    render(<TaskEditor {...defaultProps} />);
    expect(screen.getByLabelText('Detail title')).toHaveValue('Test Task');
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
});
