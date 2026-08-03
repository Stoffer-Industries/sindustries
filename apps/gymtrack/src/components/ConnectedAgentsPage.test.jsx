import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockListConnectedAgents = vi.fn();
const mockRevokeConnectedAgent = vi.fn();

vi.mock('../lib/connectedAgents.js', () => ({
  listConnectedAgents: (...args) => mockListConnectedAgents(...args),
  revokeConnectedAgent: (...args) => mockRevokeConnectedAgent(...args),
  fetchOAuthClient: vi.fn(),
  submitAgentConsentDecision: vi.fn()
}));

import ConnectedAgentsPage from './ConnectedAgentsPage.jsx';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/agents']}>
      <Routes>
        <Route path="/settings/agents" element={<ConnectedAgentsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectedAgentsPage', () => {
  it('renders connected agents returned by the query', async () => {
    mockListConnectedAgents.mockResolvedValueOnce({
      data: [
        {
          id: 'consent-1',
          clientId: 'claude-desktop',
          clientName: 'Claude Desktop',
          scope: 'history:read progression:read workouts:write',
          grantedAt: '2026-08-03T00:00:00.000Z',
          lastUsedAt: '2026-08-03T01:00:00.000Z'
        }
      ],
      error: null
    });

    renderPage();

    expect(await screen.findByTestId('connected-agents-list')).toBeInTheDocument();
    expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    expect(screen.getByText(/history:read/i)).toBeInTheDocument();
  });

  it('revokes an agent and reloads the list', async () => {
    mockListConnectedAgents
      .mockResolvedValueOnce({
        data: [
          {
            id: 'consent-1',
            clientId: 'claude-desktop',
            clientName: 'Claude Desktop',
            scope: 'history:read progression:read workouts:write',
            grantedAt: '2026-08-03T00:00:00.000Z',
            lastUsedAt: null
          }
        ],
        error: null
      })
      .mockResolvedValueOnce({ data: [], error: null });
    mockRevokeConnectedAgent.mockResolvedValueOnce({ error: null });

    renderPage();

    fireEvent.click(await screen.findByTestId('revoke-agent-consent-1'));

    await waitFor(() => {
      expect(mockRevokeConnectedAgent).toHaveBeenCalledWith('consent-1');
    });
    expect(await screen.findByTestId('connected-agents-empty')).toBeInTheDocument();
  });
});
