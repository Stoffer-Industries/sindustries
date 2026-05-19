import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.jsx';

describe('website app', () => {
  test('renders the long-scroll home messaging', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /stay relevant in an ever-changing world/i })).toBeInTheDocument();
    expect(screen.getByText(/ai-native builder\/operator company/i)).toBeInTheDocument();
  });

  test('renders section navigation and footer contact', () => {
    render(<App />);

    expect(screen.getAllByRole('link', { name: /signals/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /compounding value over time\./i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /bounded bets/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^about$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /email tom/i })).toBeInTheDocument();
  });
});
