import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TokensPage } from './TokensPage.jsx';

describe('TokensPage', () => {
  it('renders the CSS token specimen', async () => {
    const user = userEvent.setup();
    render(<TokensPage />);

    expect(screen.getByRole('heading', { name: 'CSS token specimen' })).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Color labels')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
    expect(screen.getByText('Radius')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.queryByText('Component sample')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Tasks' })).toHaveAttribute('href', '/');

    const shell = screen.getByRole('main');
    const toggle = screen.getByRole('button', { name: 'Switch to light theme' });

    expect(shell).toHaveAttribute('data-si-theme', 'dark');
    await user.click(toggle);
    expect(shell).toHaveAttribute('data-si-theme', 'light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });
});
