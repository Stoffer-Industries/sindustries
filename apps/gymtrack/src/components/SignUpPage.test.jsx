import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockSignUp = vi.fn();
const mockStartOAuthRedirect = vi.fn();

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: null,
    signUp: mockSignUp,
    startOAuthRedirect: mockStartOAuthRedirect
  })
}));

vi.mock('../lib/authFlow.js', () => ({
  DISABLED_OAUTH_PROVIDERS: ['apple'],
  SUPPORTED_OAUTH_PROVIDERS: ['google', 'apple']
}));

import SignUpPage from './SignUpPage.jsx';

const mockLocationAssign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('location', { ...window.location, assign: mockLocationAssign });
});

describe('SignUpPage', () => {
  it('mounts Clerk CAPTCHA before submitting and restores the form after an error', async () => {
    mockSignUp.mockResolvedValue({ data: null, error: new Error('Account already exists.') });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <SignUpPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId('signup-show-email'));
    expect(screen.getByTestId('signup-captcha')).toHaveAttribute('id', 'clerk-captcha');

    await user.type(screen.getByTestId('signup-email'), 'existing@example.com');
    await user.type(screen.getByTestId('signup-password'), 'not-the-real-password');
    await user.click(screen.getByTestId('signup-submit'));

    expect(await screen.findByTestId('signup-error')).toHaveTextContent('Account already exists.');
    expect(screen.getByTestId('signup-submit')).toBeEnabled();
    expect(screen.getByTestId('signup-submit')).toHaveTextContent('Create account');
  });
});

describe('SignUpPage Google OAuth (task 7e7826c5)', () => {
  function renderSignup() {
    return render(
      <MemoryRouter initialEntries={['/signup']}>
        <SignUpPage />
      </MemoryRouter>
    );
  }

  it('navigates to the provider URL when the redirect starts (AC4)', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/auth?client_id=fixture', redirecting: true },
      error: null,
      providerDisabled: false
    });
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    expect(await screen.findByTestId('signup-oauth-status')).toHaveTextContent('Redirecting to Google');
    expect(mockLocationAssign).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth?client_id=fixture'
    );
  });

  it('shows a visible inline error when the OAuth redirect throws (AC2)', async () => {
    mockStartOAuthRedirect.mockRejectedValue(new Error('SecurityError: sessionStorage'));
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    // The email panel is collapsed by default, so this asserts the error is
    // rendered outside it — an error shown only inside the collapsed panel
    // would be another silent no-op.
    expect(await screen.findByTestId('signup-error')).toHaveTextContent(
      /Something went wrong starting Google sign-in/
    );
  });

  it('shows a visible inline error when the provider returns an error (AC2)', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: new Error('OAuth redirect failed.'),
      providerDisabled: false
    });
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    expect(await screen.findByTestId('signup-error')).toHaveTextContent('OAuth redirect failed.');
  });

  it('removes the Google button and shows the not-available message when the provider is disabled (AC4)', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: null,
      providerDisabled: true
    });
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    expect(await screen.findByTestId('signup-error')).toHaveTextContent(
      'Sign-up with Google is not available right now. Try another option.'
    );
    expect(screen.queryByTestId('signup-google')).not.toBeInTheDocument();
  });

  it('shows a visible inline error when the provider error has no message', async () => {
    // A provider error without a usable message used to render nothing at
    // all — the exact silent no-op this task exists to remove.
    mockStartOAuthRedirect.mockResolvedValue({
      data: null,
      error: { code: 'oauth_failed', message: '' },
      providerDisabled: false
    });
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    expect(await screen.findByTestId('signup-error')).toHaveTextContent(
      'Could not start Google sign-in. Try again, or use email + password instead.'
    );
  });

  it('disables the Google button while the redirect is in flight', async () => {
    mockStartOAuthRedirect.mockResolvedValue({
      data: { url: 'https://accounts.google.com/o/oauth2/auth?client_id=fixture', redirecting: true },
      error: null,
      providerDisabled: false
    });
    const user = userEvent.setup();
    renderSignup();

    await user.click(screen.getByTestId('signup-google'));

    await screen.findByTestId('signup-oauth-status');
    expect(screen.getByTestId('signup-google')).toBeDisabled();
  });
});
