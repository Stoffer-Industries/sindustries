import { beforeEach, describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.jsx';

describe('website app', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  test('renders home messaging', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /stay relevant in an ever-changing world\./i })).toBeInTheDocument();
    expect(screen.getByText(/ai-native business for building in public/i)).toBeInTheDocument();
  });

  test('navigates to about and contact routes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: /about/i }));
    expect(screen.getByText(/founder profile/i)).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /contact/i }));
    expect(screen.getByText(/follow along/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /hello@sindustries.co.nz/i }).length).toBeGreaterThan(0);
  });
});
