import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DesignSystemTab } from './DesignSystemTab.jsx';

describe('DesignSystemTab', () => {
  it('renders the design-kit navigation from DesignSystemPage', () => {
    render(<DesignSystemTab />);
    expect(screen.getByRole('navigation', { name: 'Design kit' })).toBeTruthy();
  });

  it('renders the back link with href and label pointing at Tasks', () => {
    render(<DesignSystemTab />);
    const backLink = screen.getByRole('link', { name: /Tasks/ });
    expect(backLink.getAttribute('href')).toBe('/tasks');
  });

  it('renders the Tokens kit tab as active by default', () => {
    render(<DesignSystemTab />);
    const tokensTab = screen.getByRole('button', { name: 'Tokens' });
    expect(tokensTab.getAttribute('aria-current')).toBe('page');
  });
});
