import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar, StatefulSidebar } from './Sidebar.jsx';

const TABS = [
  { id: 'a', label: 'Alpha', path: '/a', icon: <span data-testid="icon-a" /> },
  { id: 'b', label: 'Bravo', path: '/b', icon: <span data-testid="icon-b" /> }
];

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('Sidebar (stateless)', () => {
  it('renders one nav row per tab and the collapse toggle', () => {
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-a')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-tab-b')).toBeTruthy();
    expect(screen.getByTestId('pulse-sidebar-toggle')).toBeTruthy();
  });

  it('marks the active tab with aria-current="page"', () => {
    render(<Sidebar tabs={TABS} activeTabId="b" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar-tab-b').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('pulse-sidebar-tab-a').getAttribute('aria-current')).toBeFalsy();
  });

  it('updates the URL when a tab is clicked', () => {
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    fireEvent.click(screen.getByTestId('pulse-sidebar-tab-b'));
    expect(window.location.pathname).toBe('/b');
  });

  it('forwards aria-label from the tab label so the row stays accessible in collapsed mode', () => {
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={true} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar-tab-a').getAttribute('aria-label')).toBe('Alpha');
  });

  it('reflects the collapsed prop on the wrapper and toggle label', () => {
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={true} onToggleCollapsed={() => {}} />);
    const sidebar = screen.getByTestId('pulse-sidebar');
    expect(sidebar.getAttribute('data-collapsed')).toBe('true');
    expect(sidebar.className).toContain('pulse-sidebar--collapsed');
    expect(screen.getByTestId('pulse-sidebar-toggle').getAttribute('aria-label')).toBe('Expand sidebar');
  });

  it('invokes onToggleCollapsed when the toggle is clicked', () => {
    const onToggle = vi.fn();
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={onToggle} />);
    fireEvent.click(screen.getByTestId('pulse-sidebar-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('StatefulSidebar', () => {
  it('defaults to expanded (data-collapsed="false") on first render', () => {
    render(<StatefulSidebar tabs={TABS} activeTabId="a" />);
    expect(screen.getByTestId('pulse-sidebar').getAttribute('data-collapsed')).toBe('false');
  });

  it('flips data-collapsed and writes localStorage when toggled', () => {
    render(<StatefulSidebar tabs={TABS} activeTabId="a" />);
    const sidebar = screen.getByTestId('pulse-sidebar');
    expect(sidebar.getAttribute('data-collapsed')).toBe('false');
    fireEvent.click(screen.getByTestId('pulse-sidebar-toggle'));
    expect(sidebar.getAttribute('data-collapsed')).toBe('true');
    expect(window.localStorage.getItem('pulse.sidebar.collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('pulse-sidebar-toggle'));
    expect(sidebar.getAttribute('data-collapsed')).toBe('false');
    expect(window.localStorage.getItem('pulse.sidebar.collapsed')).toBe('false');
  });

  it('honours a stored collapsed value from a previous session', () => {
    window.localStorage.setItem('pulse.sidebar.collapsed', 'true');
    render(<StatefulSidebar tabs={TABS} activeTabId="a" />);
    expect(screen.getByTestId('pulse-sidebar').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('pulse-sidebar-toggle').getAttribute('aria-label')).toBe('Expand sidebar');
  });

  it('updates aria-pressed on the toggle based on collapsed state', () => {
    render(<StatefulSidebar tabs={TABS} activeTabId="a" />);
    // expanded ⇒ the toggle has NOT been pressed yet
    expect(screen.getByTestId('pulse-sidebar-toggle').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('pulse-sidebar-toggle'));
    // collapsed ⇒ the toggle is now in the "pressed" state
    expect(screen.getByTestId('pulse-sidebar-toggle').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('pulse-sidebar-toggle'));
    expect(screen.getByTestId('pulse-sidebar-toggle').getAttribute('aria-pressed')).toBe('false');
  });
});
