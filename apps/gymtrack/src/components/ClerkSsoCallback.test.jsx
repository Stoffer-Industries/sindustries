import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@clerk/react', () => ({
  HandleSSOCallback: ({ navigateToApp }) => (
    <button onClick={() => navigateToApp({ decorateUrl: (value) => value })}>
      finish SSO
    </button>
  )
}));

import ClerkSsoCallback from './ClerkSsoCallback.jsx';
import { rememberClerkSsoDestination } from '../lib/clerkSsoDestination.js';

beforeEach(() => window.sessionStorage.clear());

describe('ClerkSsoCallback', () => {
  it('returns a protected-route OAuth attempt to its original destination', async () => {
    rememberClerkSsoDestination('/history?range=30');
    render(
      <MemoryRouter initialEntries={['/sso-callback']}>
        <Routes>
          <Route path="/sso-callback" element={<ClerkSsoCallback />} />
          <Route path="/history" element={<p>history destination</p>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'finish SSO' }));

    expect(await screen.findByText('history destination')).toBeVisible();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('refuses to persist an external redirect target', async () => {
    rememberClerkSsoDestination('https://attacker.example/steal');
    render(
      <MemoryRouter initialEntries={['/sso-callback']}>
        <Routes>
          <Route path="/sso-callback" element={<ClerkSsoCallback />} />
          <Route path="/workout" element={<p>safe fallback</p>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'finish SSO' }));

    expect(await screen.findByText('safe fallback')).toBeVisible();
  });
});
