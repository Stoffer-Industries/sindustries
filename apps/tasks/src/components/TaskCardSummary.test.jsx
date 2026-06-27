import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCardSummary } from './TaskCardSummary.jsx';

describe('TaskCardSummary', () => {
  it('copies the task ID without triggering the title click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const onTitleClick = vi.fn();

    render(
      <TaskCardSummary
        task={{
          id: 'task-123',
          title: 'Copy target',
          priority: 'medium',
          status: 'ready',
          tags: []
        }}
        onTitleClick={onTitleClick}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID task-123' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('task-123'));
    expect(screen.getByRole('button', { name: 'Copy task ID task-123' })).toHaveTextContent('Copied');
    expect(onTitleClick).not.toHaveBeenCalled();
  });
});
