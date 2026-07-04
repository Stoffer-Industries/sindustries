import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from './App.jsx';

beforeEach(() => {
  // Reset history between tests so each starts at root.
  window.history.pushState({}, '', '/');
});

describe('Pulse shell', () => {
  it('renders the tabbar with three tabs', () => {
    render(<App />);
    expect(screen.getByTestId('pulse-tabbar')).toBeTruthy();
    expect(screen.getByTestId('pulse-tab-tasks')).toBeTruthy();
    expect(screen.getByTestId('pulse-tab-bookmarks')).toBeTruthy();
    expect(screen.getByTestId('pulse-tab-flow-metrics')).toBeTruthy();
  });

  it('routes to a tab matching the URL path on first render', () => {
    window.history.pushState({}, '', '/flow-metrics');
    render(<App />);
    const active = screen.getByTestId('pulse-tab-flow-metrics');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('falls back to the default tab for unknown paths', () => {
    window.history.pushState({}, '', '/no-such-tab');
    render(<App />);
    const active = screen.getByTestId('pulse-tab-tasks');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('switches tabs without a full page reload and updates the URL', () => {
    render(<App />);
    const bookmarks = screen.getByTestId('pulse-tab-bookmarks');
    fireEvent.click(bookmarks);
    expect(window.location.pathname).toBe('/bookmarks');
    expect(bookmarks.getAttribute('aria-current')).toBe('page');
  });
});
