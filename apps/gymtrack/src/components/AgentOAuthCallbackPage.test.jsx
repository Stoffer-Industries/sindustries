import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import AgentOAuthCallbackPage from './AgentOAuthCallbackPage.jsx';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/oauth/callback" element={<AgentOAuthCallbackPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AgentOAuthCallbackPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the success state with the authorization code and a working copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    renderAt('/oauth/callback?code=abc123&state=opaque-state');

    expect(
      screen.getByRole('heading', { name: 'Agent connection complete' })
    ).toBeInTheDocument();
    const code = screen.getByTestId('agent-oauth-callback-code');
    expect(code).toHaveTextContent('abc123');
    expect(screen.getByTestId('agent-oauth-callback-state')).toHaveTextContent('opaque-state');

    const copyButton = screen.getByTestId('agent-oauth-callback-copy');
    fireEvent.click(copyButton);

    await waitFor(() => expect(screen.getByTestId('agent-oauth-callback-copy')).toHaveTextContent('Copied!'));
    expect(writeText).toHaveBeenCalledWith('abc123');
  });

  it('renders the denial state with the error_description surfaced in a role=alert banner', () => {
    renderAt('/oauth/callback?error=access_denied&error_description=You%20cancelled');

    expect(
      screen.getByRole('heading', { name: 'Agent connection denied' })
    ).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You cancelled');
    // The code <output> is only rendered in the success state, so its
    // absence here is the assertion that the page did not fall through.
    expect(screen.queryByTestId('agent-oauth-callback-code')).toBeNull();
  });

  it('falls back to the raw `error` query value when `error_description` is missing', () => {
    renderAt('/oauth/callback?error=access_denied');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('access_denied');
  });

  it('renders the empty fallback when neither code nor error is present', () => {
    renderAt('/oauth/callback');

    expect(
      screen.getByRole('heading', { name: 'No authorization code was returned' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('agent-oauth-callback-code')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call the clipboard when there is no code to copy (empty state)', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    renderAt('/oauth/callback');

    // Empty state renders no copy button at all.
    expect(screen.queryByTestId('agent-oauth-callback-copy')).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});
