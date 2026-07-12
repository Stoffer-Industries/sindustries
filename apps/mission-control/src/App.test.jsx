import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from './App.jsx';

// Vitest runs inside jsdom which provides localStorage. Reset it between
// tests so the sidebar collapse state doesn't leak across cases.
beforeEach(() => {
  window.history.pushState({}, '', '/');
  window.localStorage.clear();
});

describe('Pulse shell', () => {
  it('renders the sidebar with the registered tabs', () => {
    render(<App />);
    expect(screen.getByTestId('pulse-sidebar')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-tasks')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-bookmarks')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-flow-metrics')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-design-system')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-content-scheduler')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-sindustries')).toBeTruthy();
  });

  it('routes /sindustries to the SIndustries tab', () => {
    window.history.pushState({}, '', '/sindustries');
    render(<App />);
    const active = screen.getByTestId('pulse-sidebar-tab-sindustries');
    expect(active.getAttribute('aria-current')).toBe('page');
    // The SIndustries iframe is in the active content area.
    expect(screen.getByTestId('pulse-sindustries')).toBeTruthy();
  });

  it('routes to a tab matching the URL path on first render', () => {
    window.history.pushState({}, '', '/flow-metrics');
    render(<App />);
    const active = screen.getByTestId('pulse-sidebar-tab-flow-metrics');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('falls back to the default tab for unknown paths', () => {
    window.history.pushState({}, '', '/no-such-tab');
    render(<App />);
    const active = screen.getByTestId('pulse-sidebar-tab-tasks');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('switches tabs without a full page reload and updates the URL', () => {
    render(<App />);
    const bookmarks = screen.getByTestId('pulse-sidebar-tab-bookmarks');
    fireEvent.click(bookmarks);
    expect(window.location.pathname).toBe('/bookmarks');
    expect(bookmarks.getAttribute('aria-current')).toBe('page');
  });

  it('routes to the Design System tab when /design-system is the initial URL', () => {
    window.history.pushState({}, '', '/design-system');
    render(<App />);
    const designSystem = screen.getByTestId('pulse-sidebar-tab-design-system');
    expect(designSystem.getAttribute('aria-current')).toBe('page');
  });
});
