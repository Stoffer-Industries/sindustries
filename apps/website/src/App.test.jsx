import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.jsx';

describe('website app', () => {
  test('renders the long-scroll home messaging', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /build the systems\. ship the signal\./i })).toBeInTheDocument();
    expect(screen.getByText(/ai-native builder\/operator company/i)).toBeInTheDocument();
  });

  test('renders section navigation and footer contact', () => {
    render(<App />);

    expect(screen.getAllByRole('link', { name: /signals/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /hero cards for the machines in motion\./i })).toBeInTheDocument();
    expect(screen.getByText(/about: sindustries builds practical digital products/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /hello@sindustries.co.nz/i }).length).toBeGreaterThan(0);
  });
});
