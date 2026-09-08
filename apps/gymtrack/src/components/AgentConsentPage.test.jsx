import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockFetchOAuthClient = vi.fn();
const mockSubmitAgentConsentDecision = vi.fn();

vi.mock('../lib/connectedAgents.js', () => ({
  fetchOAuthClient: (...args) => mockFetchOAuthClient(...args),
  submitAgentConsentDecision: (...args) => mockSubmitAgentConsentDecision(...args)
}));

// Mock auth so useAuth() returns a signed-in session — submitAgentConsentDecision
// sends session.access_token to the API.
vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: { access_token: 'fake-access-token', user: { id: 'user-1' } },
    user: { id: 'user-1' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn()
  }),
  AuthProvider: ({ children }) => children
}));

import AgentConsentPage from './AgentConsentPage.jsx';

const SEARCH =
  '/agent-consent' +
  '?client_id=claude-desktop' +
  '&redirect_uri=https%3A%2F%2Fclaude.example%2Fcallback' +
  '&response_type=code' +
  '&scope=history%3Aread%20progression%3Aread%20workouts%3Awrite' +
  '&state=opaque-state' +
  '&code_challenge=pkce-challenge' +
  '&code_challenge_method=S256';

function renderConsentPage() {
  return render(
    <MemoryRouter initialEntries={[SEARCH]}>
      <Routes>
        <Route path="/agent-consent" element={<AgentConsentPage />} />
      </Routes>
    </MemoryRouter>
  );
}

// jsdom's window.location.assign is non-configurable; stub the global
// `location` so handleDecision(true) doesn't try to actually navigate
// during the test. Restore in afterEach via vi.unstubAllGlobals (setup.js
// already calls vi.restoreAllMocks; we add unstubAllGlobals at the end).
const mockLocationAssign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchOAuthClient.mockResolvedValue({
    data: {
      client_id: 'claude-desktop',
      client_name: 'Claude Desktop',
      redirect_uris: ['https://claude.example/callback']
    },
    error: null
  });
  vi.stubGlobal('location', {
    ...window.location,
    assign: mockLocationAssign
  });
});

describe('AgentConsentPage', () => {
  it('renders the resolved client name in the consent card heading', async () => {
    renderConsentPage();

    const card = await screen.findByTestId('agent-consent-card');
    const heading = card.querySelector('h2');
    expect(heading).not.toBeNull();
    expect(heading).toHaveTextContent('Claude Desktop');
  });

  it('renders one <li> per requested scope from the query string', async () => {
    renderConsentPage();

    const card = await screen.findByTestId('agent-consent-card');
    const items = within(card).getAllByRole('listitem');
    expect(items.map((li) => li.textContent).sort()).toEqual([
      'history:read',
      'progression:read',
      'workouts:write'
    ]);
  });

  it('does NOT render the raw redirect_uri anywhere in the consent card (AC1)', async () => {
    renderConsentPage();

    const card = await screen.findByTestId('agent-consent-card');

    // No `Redirect:` label at all.
    expect(within(card).queryByText(/Redirect:/i)).toBeNull();
    // No raw URL substring from the redirect_uri we injected.
    expect(within(card).queryByText(/claude\.example/i)).toBeNull();
    expect(within(card).queryByText(/127\.0\.0\.1/i)).toBeNull();
  });

  it('falls back to client_id in the heading when the OAuth client lookup fails', async () => {
    mockFetchOAuthClient.mockResolvedValueOnce({
      data: null,
      error: { message: 'Unknown OAuth client.' }
    });

    renderConsentPage();

    await screen.findByTestId('agent-consent-error');
    // Even on error, no redirect text should be rendered.
    expect(screen.queryByText(/Redirect:/i)).toBeNull();
    // The page-level subtitle still surfaces client_id while loading/error.
    expect(screen.getByText(/claude-desktop/i)).toBeInTheDocument();
  });

  it('renders the Approve and Cancel buttons inside the consent card', async () => {
    renderConsentPage();

    const card = await screen.findByTestId('agent-consent-card');
    expect(within(card).getByTestId('agent-consent-approve')).toHaveTextContent(/Approve access/i);
    expect(within(card).getByTestId('agent-consent-deny')).toHaveTextContent(/Cancel/i);
  });

  it('submits an approve decision with the redirect_uri (still flows to the API, just not rendered)', async () => {
    mockSubmitAgentConsentDecision.mockResolvedValueOnce({
      data: { redirectTo: 'https://claude.example/callback?code=auth-code&state=opaque-state' },
      error: null
    });

    renderConsentPage();
    const card = await screen.findByTestId('agent-consent-card');
    fireEvent.click(within(card).getByTestId('agent-consent-approve'));

    await waitFor(() => {
      expect(mockSubmitAgentConsentDecision).toHaveBeenCalledTimes(1);
    });
    const callArg = mockSubmitAgentConsentDecision.mock.calls[0][0];
    expect(callArg.approve).toBe(true);
    expect(callArg.redirect_uri).toBe('https://claude.example/callback');
    expect(callArg.client_id).toBe('claude-desktop');
    expect(callArg.scope).toBe('history:read progression:read workouts:write');
    expect(callArg.state).toBe('opaque-state');
    expect(callArg.code_challenge).toBe('pkce-challenge');
    expect(callArg.code_challenge_method).toBe('S256');
    expect(callArg.accessToken).toBe('fake-access-token');
    expect(mockLocationAssign).toHaveBeenCalledWith(
      'https://claude.example/callback?code=auth-code&state=opaque-state'
    );
  });

  it('submits a deny decision and does not navigate away', async () => {
    mockSubmitAgentConsentDecision.mockResolvedValueOnce({ data: null, error: null });

    renderConsentPage();
    const card = await screen.findByTestId('agent-consent-card');
    fireEvent.click(within(card).getByTestId('agent-consent-deny'));

    await waitFor(() => {
      expect(mockSubmitAgentConsentDecision).toHaveBeenCalledTimes(1);
    });
    expect(mockSubmitAgentConsentDecision.mock.calls[0][0].approve).toBe(false);
    expect(mockLocationAssign).not.toHaveBeenCalled();
  });
});
