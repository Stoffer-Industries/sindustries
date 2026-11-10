import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

const mockSignUp = vi.fn();
const mockVerifySignUpCode = vi.fn();
const mockStartOAuthRedirect = vi.fn();

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: null,
    signUp: mockSignUp,
    verifySignUpCode: mockVerifySignUpCode,
    startOAuthRedirect: mockStartOAuthRedirect
  })
}));

vi.mock('../lib/authFlow.js', () => ({
  DISABLED_OAUTH_PROVIDERS: ['apple'],
  SUPPORTED_OAUTH_PROVIDERS: ['google', 'apple']
}));

import SignUpPage from './SignUpPage.jsx';

const mockLocationAssign = vi.fn();

/**
 * Exposes the router's current path so a test can assert the navigation
 * target without reaching into the component's internals.
 */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-path">{location.pathname}</output>;
}

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

/**
 * The email-verification step of the sign-up flow (task 6e9410d5).
 *
 * Before this task the account was created, the emailed code was thrown
 * away, and the user was navigated to a protected route that bounced them
 * straight back to /login — there was no field anywhere to enter the code.
 */
describe('SignUpPage email verification step (task 6e9410d5)', () => {
  const EMAIL = 'new-user@example.com';
  const PASSWORD = 'correct-horse-battery';

  /** Renders the page plus a probe that exposes the router location. */
  function renderSignup() {
    return render(
      <MemoryRouter initialEntries={['/signup']}>
        <SignUpPage />
        <LocationProbe />
      </MemoryRouter>
    );
  }

  /** Fills in the email + password form and submits it. */
  async function submitSignUpForm(user) {
    await user.click(screen.getByTestId('signup-show-email'));
    await user.type(screen.getByTestId('signup-email'), EMAIL);
    await user.type(screen.getByTestId('signup-password'), PASSWORD);
    await user.click(screen.getByTestId('signup-submit'));
  }

  beforeEach(() => {
    mockSignUp.mockResolvedValue({
      data: { needsVerification: true, verificationMode: 'signup_email_code' },
      error: null
    });
  });

  it('renders the verification-code input when sign-up requires email verification (AC1)', async () => {
    const user = userEvent.setup();
    renderSignup();

    await submitSignUpForm(user);

    expect(await screen.findByTestId('signup-verification-code')).toBeVisible();
    expect(screen.getByTestId('signup-verification-form')).toBeVisible();
    // The sign-up must not be re-submitted against an account that already
    // exists, so the Create-account button is disabled and relabelled.
    expect(screen.getByTestId('signup-submit')).toBeDisabled();
    expect(screen.getByTestId('signup-submit')).toHaveTextContent('Verification pending');
    // The address the user typed is still there.
    expect(screen.getByTestId('signup-email')).toHaveValue(EMAIL);
  });

  it('routes to /workout after the code is verified (AC2)', async () => {
    mockVerifySignUpCode.mockResolvedValue({ data: { session: 'sess_test' }, error: null });
    const user = userEvent.setup();
    renderSignup();

    await submitSignUpForm(user);
    await screen.findByTestId('signup-verification-code');
    await user.type(screen.getByTestId('signup-verification-code'), '123456');
    await user.click(screen.getByTestId('signup-verify-submit'));

    expect(await screen.findByTestId('location-path')).toHaveTextContent('/workout');
    expect(mockVerifySignUpCode).toHaveBeenCalledWith('123456');
  });

  it('shows an inline error and preserves the entered email and password when the code is wrong (AC3)', async () => {
    mockVerifySignUpCode.mockResolvedValue({
      data: null,
      error: new Error('That code is not valid.')
    });
    const user = userEvent.setup();
    renderSignup();

    await submitSignUpForm(user);
    await screen.findByTestId('signup-verification-code');
    await user.type(screen.getByTestId('signup-verification-code'), '000000');
    await user.click(screen.getByTestId('signup-verify-submit'));

    const errorRegion = await screen.findByTestId('signup-verification-error');
    expect(errorRegion).toHaveTextContent('That code is not valid.');
    expect(errorRegion).toHaveAttribute('role', 'alert');
    // Nothing the user already entered is lost, so the code can be corrected
    // and retried without retyping the credentials.
    expect(screen.getByTestId('signup-email')).toHaveValue(EMAIL);
    expect(screen.getByTestId('signup-password')).toHaveValue(PASSWORD);
    expect(screen.getByTestId('signup-verification-code')).toBeEnabled();
    expect(screen.getByTestId('signup-submit')).toBeDisabled();
  });

  it('runs the whole sign-up -> code -> /workout flow in one pass (AC4)', async () => {
    mockVerifySignUpCode.mockResolvedValue({ data: { session: 'sess_test' }, error: null });
    const user = userEvent.setup();
    renderSignup();

    // 1. Submit the sign-up form.
    await submitSignUpForm(user);

    // 2. The code field appears.
    const codeInput = await screen.findByTestId('signup-verification-code');
    expect(codeInput).toBeVisible();

    // 3. Submit the code.
    await user.type(codeInput, '123456');
    await user.click(screen.getByTestId('signup-verify-submit'));

    // 4. The user lands on /workout.
    expect(await screen.findByTestId('location-path')).toHaveTextContent('/workout');
  });

  it('does not render the verification step when the provider issues a session immediately', async () => {
    mockSignUp.mockResolvedValue({
      data: { needsVerification: false },
      error: null
    });
    const user = userEvent.setup();
    renderSignup();

    await submitSignUpForm(user);

    expect(await screen.findByTestId('location-path')).toHaveTextContent('/workout');
    expect(screen.queryByTestId('signup-verification-code')).not.toBeInTheDocument();
    expect(mockVerifySignUpCode).not.toHaveBeenCalled();
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
