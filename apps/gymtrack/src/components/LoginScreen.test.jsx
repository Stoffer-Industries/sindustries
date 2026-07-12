import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/supabase.js', () => ({ supabase: { auth: { getUser: vi.fn(), onAuthStateChange: vi.fn() } } }));

const mockSignIn = vi.fn();
vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({
    session: null,
    user: null,
    loading: false,
    signIn: mockSignIn,
    signUp: vi.fn(),
    signOut: vi.fn()
  }),
  AuthProvider: ({ children }) => children
}));

import LoginScreen from './LoginScreen.jsx';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginScreen />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoginScreen', () => {
  it('renders email + password form', () => {
    renderLogin();
    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
    expect(screen.getByTestId('login-password')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeInTheDocument();
  });

  it('shows inline error when sign-in fails', async () => {
    mockSignIn.mockResolvedValueOnce({ data: null, error: new Error('Invalid credentials') });
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByTestId('login-email'), 'tom@example.com');
    await user.type(screen.getByTestId('login-password'), 'wrongpassword');
    await user.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('login-error')).toHaveTextContent(/Invalid credentials/);
    expect(mockSignIn).toHaveBeenCalledWith('tom@example.com', 'wrongpassword');
  });
});