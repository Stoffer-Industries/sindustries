import { describe, expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    expect(screen.getByRole('heading', { name: /compounding value over time/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /proof before scale/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /systems, explorations and output signals/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^about$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /email tom/i })).toBeInTheDocument();
  });

  test('renders CTAs and cards from the @sindustries/ui brand kit', () => {
    render(<App />);

    const cta = screen
      .getAllByRole('link', { name: /follow tom on x/i })
      .find((element) => element.classList.contains('si-button'));
    expect(cta).toHaveClass('si-button', 'si-button--primary');

    const shipRow = screen.getByRole('button', { name: /open release detail for sindustries v1 site/i });
    expect(shipRow).toHaveClass('si-card', 'si-card--interactive', 'ship-row');
  });

  test('opens and closes release detail from a ship card', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /open release detail for sindustries v1 site/i }));

    expect(screen.getByRole('dialog', { name: /sindustries v1 site/i })).toBeInTheDocument();
    expect(screen.getByText(/live website refresh completed/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close detail sheet/i }));
    expect(screen.queryByRole('dialog', { name: /sindustries v1 site/i })).not.toBeInTheDocument();
  });

  test('opens story detail from a story card', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /open story detail for turning an assistant into a chief of staff/i }));

    const dialog = screen.getByRole('dialog', { name: /turning an assistant into a chief of staff/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getAllByText(/delegation, memory, workflows, and leverage/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('link', { name: /canonical source/i })).toHaveAttribute('href', expect.stringContaining('x.com'));
  });
});
