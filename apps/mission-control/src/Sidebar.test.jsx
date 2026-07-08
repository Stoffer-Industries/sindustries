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

describe('ThemeToggle (shell-owned day/night theme)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-si-theme');
  });

  it('renders with a "Switch to light" label when the persisted theme is dark', () => {
    window.localStorage.setItem('pulse-theme', 'dark');
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar-theme-toggle').getAttribute('aria-label')).toBe('Switch to light theme');
  });

  it('renders with a "Switch to dark" label when the persisted theme is light', () => {
    window.localStorage.setItem('pulse-theme', 'light');
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar-theme-toggle').getAttribute('aria-label')).toBe('Switch to dark theme');
  });

  it('flips data-si-theme on <html> and writes the new value to localStorage on click', () => {
    window.localStorage.setItem('pulse-theme', 'dark');
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(document.documentElement.getAttribute('data-si-theme')).toBe('dark');
    fireEvent.click(screen.getByTestId('pulse-sidebar-theme-toggle'));
    expect(document.documentElement.getAttribute('data-si-theme')).toBe('light');
    expect(window.localStorage.getItem('pulse-theme')).toBe('light');
  });

  it('broadcasts a pulse:theme postMessage to every iframe on click', () => {
    window.localStorage.setItem('pulse-theme', 'dark');
    const iframe = document.createElement('iframe');
    const posted = [];
    // jsdom does not provide contentWindow.postMessage; install a stub
    // that records the call so we can assert the broadcast contract.
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage: (payload, origin) => posted.push({ payload, origin }) }
    });
    document.body.appendChild(iframe);

    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    fireEvent.click(screen.getByTestId('pulse-sidebar-theme-toggle'));

    expect(posted).toHaveLength(1);
    expect(posted[0].payload).toEqual({ type: 'pulse:theme', theme: 'light' });
    expect(posted[0].origin).toBe(window.location.origin);

    document.body.removeChild(iframe);
  });

  it('hides the textual label in collapsed state while keeping aria-label', () => {
    window.localStorage.setItem('pulse-theme', 'dark');
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={true} onToggleCollapsed={() => {}} />);
    const toggle = screen.getByTestId('pulse-sidebar-theme-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to light theme');
    expect(toggle.className).toContain('pulse-sidebar__theme-toggle--collapsed');
  });

  it('updates the toggle label when another tab writes to pulse-theme via a storage event', () => {
    window.localStorage.setItem('pulse-theme', 'dark');
    render(<Sidebar tabs={TABS} activeTabId="a" collapsed={false} onToggleCollapsed={() => {}} />);
    expect(screen.getByTestId('pulse-sidebar-theme-toggle').getAttribute('aria-label')).toBe('Switch to light theme');

    // Simulate a sibling tab flipping the value.
    window.localStorage.setItem('pulse-theme', 'light');
    fireEvent(window, new StorageEvent('storage', { key: 'pulse-theme', newValue: 'light' }));

    expect(screen.getByTestId('pulse-sidebar-theme-toggle').getAttribute('aria-label')).toBe('Switch to dark theme');
  });
});
