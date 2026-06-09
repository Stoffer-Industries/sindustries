import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DesignSystemPage } from './DesignSystemPage.jsx';

describe('DesignSystemPage', () => {
  it('renders the design system specimen', async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage backHref="/" backLabel="← Tasks" />);

    expect(screen.getByRole('heading', { name: 'Sindustries design system' })).toBeInTheDocument();
    expect(screen.getByText('Components')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Buttons' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secondary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Destructive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ghost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display primary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display outline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display ghost' })).toBeInTheDocument();
    expect(screen.getByText('Tertiary headers')).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Color labels')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
    expect(screen.getByText('Radius')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Tasks' })).toHaveAttribute('href', '/');

    const shell = screen.getByRole('main');
    const toggle = screen.getByRole('button', { name: 'Switch to light theme' });

    expect(shell).toHaveAttribute('data-si-theme', 'dark');
    await user.click(toggle);
    expect(shell).toHaveAttribute('data-si-theme', 'light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });
});
