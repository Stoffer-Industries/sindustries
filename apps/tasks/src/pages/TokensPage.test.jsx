import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokensPage } from './TokensPage.jsx';

describe('TokensPage', () => {
  it('renders the CSS token specimen', () => {
    render(<TokensPage />);

    expect(screen.getByRole('heading', { name: 'CSS token specimen' })).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Color labels')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Tasks' })).toHaveAttribute('href', '/');
  });
});
