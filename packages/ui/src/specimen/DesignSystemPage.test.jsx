import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import { DesignSystemPage } from './DesignSystemPage.jsx';

// Helper: read the shell theme off documentElement (jsdom exposes it).
function setShellTheme(value) {
  document.documentElement.setAttribute('data-si-theme', value);
}

describe('DesignSystemPage', () => {
  beforeEach(() => {
    setShellTheme('dark');
  });

  it('renders the design system specimen', async () => {
    const user = userEvent.setup();
    render(<DesignSystemPage />);

    expect(screen.getByRole('navigation', { name: 'Design kit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tokens' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Sindustries design system' })).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.getByText('Color labels')).toBeInTheDocument();
    expect(screen.getByText('Space')).toBeInTheDocument();
    expect(screen.getByText('Radius')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Tertiary headers')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pulse / React' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brand / React' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pulse' }));
    expect(screen.getByRole('button', { name: 'Pulse' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Pulse / React' })).toBeInTheDocument();
    expect(screen.getByText('Components')).toBeInTheDocument();
    expect(screen.queryByText('Code catalog')).not.toBeInTheDocument();
    const componentsSection = screen.getByText('Components').closest('section');
    expect(within(componentsSection).getByRole('heading', { name: 'Buttons' })).toBeInTheDocument();
    expect(within(componentsSection).getByRole('heading', { name: 'Form controls' })).toBeInTheDocument();
    expect(within(componentsSection).getAllByText('CODE').length).toBeGreaterThan(1);
    expect(within(componentsSection).getByText(/pen:xBc88/)).toBeInTheDocument();
    expect(within(componentsSection).getByText(/variants: primary, secondary/)).toBeInTheDocument();
    expect(within(componentsSection).getByText(/pen:Tn1Ii/)).toBeInTheDocument();
    expect(within(componentsSection).getByText('Modal/Task Card')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Input Group/Title')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Select Group/Priority')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Divider/Dashed')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Divider/Subtle')).toBeInTheDocument();
    expect(within(componentsSection).getByRole('heading', { name: 'Dropdown' })).toBeInTheDocument();
    expect(within(componentsSection).getByText(/pen:vsaL0/)).toBeInTheDocument();
    expect(within(componentsSection).getByText('Toast/Info')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Toast/Success')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Toast/Error')).toBeInTheDocument();
    expect(within(componentsSection).getByText('Rover status update')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secondary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Destructive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ghost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display primary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display outline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display ghost' })).toBeInTheDocument();
    expect(screen.getByText('Button/Default')).toBeInTheDocument();
    expect(screen.getByText('Button/Display/Primary')).toBeInTheDocument();
    const pulsePage = screen.getByRole('heading', { name: 'Pulse / React' }).closest('section');
    expect(pulsePage).toBeTruthy();
    const surfacesBlock = within(pulsePage).getByRole('heading', { name: 'Surfaces' }).closest('.si-specimen-surface-block');
    expect(surfacesBlock).toBeTruthy();
    expect(within(surfacesBlock).getByRole('heading', { name: 'Surface Section Header' })).toBeInTheDocument();
    expect(within(surfacesBlock).getByText('Section Header')).toBeInTheDocument();
    expect(within(surfacesBlock).getByText('Fields')).toBeInTheDocument();
    expect(within(surfacesBlock).queryByLabelText('Title')).not.toBeInTheDocument();
    const componentsHeading = within(pulsePage).getByText('Components');
    expect(surfacesBlock.compareDocumentPosition(componentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Brand' }));
    expect(screen.getByRole('button', { name: 'Brand' })).toHaveAttribute('aria-current', 'page');
    const brandPage = screen.getByRole('heading', { name: 'Brand / React' }).closest('section');
    expect(brandPage).toHaveAttribute('data-si-pack', 'brand');
    expect(brandPage).toHaveAttribute('data-si-theme', 'light');
    expect(within(brandPage).getByText('Brand components')).toBeInTheDocument();
    expect(within(brandPage).getByRole('button', { name: 'Brand primary' })).toBeInTheDocument();
    expect(within(brandPage).getByRole('button', { name: 'Brand outline' })).toBeInTheDocument();
    expect(within(brandPage).getByRole('link', { name: 'canonical source' })).toBeInTheDocument();
    expect(within(brandPage).getByText('Interactive card — story and ship surfaces')).toBeInTheDocument();
    expect(within(brandPage).getByText('Ink card — dark industrial panel')).toBeInTheDocument();
    expect(within(brandPage).getByText('Button/Brand/Primary')).toBeInTheDocument();
    expect(within(brandPage).getByText('Card/Brand/Ink')).toBeInTheDocument();
  });

  // AC5 (task 205d7615): the in-page back link has been removed; the
  // Mission Control tab bar is the canonical navigation.
  it('does not render an in-page back link', () => {
    render(<DesignSystemPage />);
    expect(screen.queryByRole('link', { name: /Tasks/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Back/i })).not.toBeInTheDocument();
  });

  // AC5 (task 205d7615): the in-page theme toggle has been removed; the
  // shell's Day/Night sidebar toggle is the single source of truth.
  it('does not render an in-page theme toggle', () => {
    render(<DesignSystemPage />);
    expect(screen.queryByRole('button', { name: /Switch to .* theme/ })).not.toBeInTheDocument();
  });

  // AC6 (task 205d7615): the specimen shell mirrors the shell's
  // data-si-theme attribute on first render so the design system tab
  // renders in the active theme without a flash of wrong palette.
  it('mirrors the shell data-si-theme attribute on first render', () => {
    setShellTheme('light');
    render(<DesignSystemPage />);
    const shell = screen.getByRole('main');
    expect(shell).toHaveAttribute('data-si-theme', 'light');
  });

  // AC6 (task 205d7615): when the shell flips theme, the specimen
  // shell follows without a remount — the MutationObserver on
  // <html data-si-theme> drives a re-render.
  it('follows shell theme flips without a remount', async () => {
    setShellTheme('dark');
    render(<DesignSystemPage />);
    const shell = screen.getByRole('main');
    expect(shell).toHaveAttribute('data-si-theme', 'dark');

    setShellTheme('light');
    await waitFor(() => expect(shell).toHaveAttribute('data-si-theme', 'light'));

    setShellTheme('dark');
    await waitFor(() => expect(shell).toHaveAttribute('data-si-theme', 'dark'));
  });

  // Per-kit-page theme overrides (e.g. Brand forces light) must survive
  // the shell being in dark mode — the override is per-section, not on
  // the page shell, so the inner section still renders light.
  it('keeps per-page theme overrides intact when shell is dark', async () => {
    setShellTheme('dark');
    const user = userEvent.setup();
    render(<DesignSystemPage />);
    await user.click(screen.getByRole('button', { name: 'Brand' }));
    const brandPage = screen.getByRole('heading', { name: 'Brand / React' }).closest('section');
    expect(brandPage).toHaveAttribute('data-si-theme', 'light');
    expect(screen.getByRole('main')).toHaveAttribute('data-si-theme', 'dark');
  });
});