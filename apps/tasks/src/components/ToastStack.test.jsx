import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastStack } from './ToastStack.jsx';

describe('ToastStack', () => {
  it('renders an empty viewport when no toasts are provided', () => {
    const { container } = render(<ToastStack toasts={[]} />);
    const viewport = container.querySelector('[aria-live="polite"]');
    expect(viewport).not.toBeNull();
    expect(viewport.querySelectorAll('[class*="toast"]').length).toBe(0);
  });

  it('renders one toast per entry with the matching message', () => {
    const toasts = [
      { id: 'a', type: 'info', message: 'Saved' },
      { id: 'b', type: 'error', message: 'Boom' }
    ];
    render(<ToastStack toasts={toasts} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('uses a stable key prop so React reuses toast elements on update', () => {
    const toasts = [{ id: 'stable', type: 'success', message: 'Stable ID' }];
    const { rerender } = render(<ToastStack toasts={toasts} />);
    rerender(<ToastStack toasts={toasts} />);
    expect(screen.getByText('Stable ID')).toBeInTheDocument();
  });
});
