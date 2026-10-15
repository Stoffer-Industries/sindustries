import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockSignUp = vi.fn();

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: null,
    signUp: mockSignUp,
    startOAuthRedirect: vi.fn()
  })
}));

vi.mock('../lib/authFlow.js', () => ({
  DISABLED_OAUTH_PROVIDERS: ['apple'],
  SUPPORTED_OAUTH_PROVIDERS: ['google', 'apple']
}));

import SignUpPage from './SignUpPage.jsx';

beforeEach(() => vi.clearAllMocks());

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
