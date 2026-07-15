import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DesignSystemTab } from './DesignSystemTab.jsx';

// Helper: read the shell theme off documentElement (jsdom exposes it).
function setShellTheme(value) {
  document.documentElement.setAttribute('data-si-theme', value);
}

describe('DesignSystemTab', () => {
  beforeEach(() => {
    setShellTheme('dark');
  });

  it('renders the design-kit navigation from DesignSystemPage', () => {
    render(<DesignSystemTab />);
    expect(screen.getByRole('navigation', { name: 'Design kit' })).toBeTruthy();
  });

  // AC5 (task 205d7615): the in-page back link has been removed; the
  // Mission Control tab bar is the canonical navigation.
  it('does not render an in-page back link', () => {
    render(<DesignSystemTab />);
    expect(screen.queryByRole('link', { name: /Tasks/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Back/ })).toBeNull();
  });

  // AC5 (task 205d7615): the in-page theme toggle has been removed; the
  // shell's Day/Night sidebar toggle owns data-si-theme globally.
  it('does not render an in-page theme toggle', () => {
    render(<DesignSystemTab />);
    expect(screen.queryByRole('button', { name: /Switch to .* theme/ })).toBeNull();
  });

  it('renders the Tokens kit tab as active by default', () => {
    render(<DesignSystemTab />);
    const tokensTab = screen.getByRole('button', { name: 'Tokens' });
    expect(tokensTab.getAttribute('aria-current')).toBe('page');
  });

  // AC6 (task 205d7615): the design system tab picks up the shell's
  // current theme via the specimen's MutationObserver on
  // <html data-si-theme>.
  it('mirrors the shell data-si-theme on first render', () => {
    setShellTheme('light');
    render(<DesignSystemTab />);
    expect(screen.getByRole('main')).toHaveAttribute('data-si-theme', 'light');
  });

  // AC6 (task 205d7615): the tab follows shell theme flips without a
  // remount — the specimen observes <html data-si-theme>.
  it('follows shell theme flips without a remount', async () => {
    setShellTheme('dark');
    render(<DesignSystemTab />);
    const shell = screen.getByRole('main');
    expect(shell).toHaveAttribute('data-si-theme', 'dark');

    setShellTheme('light');
    await waitFor(() => expect(shell).toHaveAttribute('data-si-theme', 'light'));
  });
});