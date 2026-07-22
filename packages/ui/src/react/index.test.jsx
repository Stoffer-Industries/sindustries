import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, Badge, Button, Card, CardContainer, Divider, DropdownOption, Field, Input, SearchInput, Toast, Tooltip } from './index.jsx';

describe('@sindustries/ui/react', () => {
  it('renders Pulse button variants with accessible props', () => {
    render(
      <>
        <Button variant="primary" tone="pulse" aria-label="Create task">
          Create
        </Button>
        <Button variant="outline">Outline</Button>
      </>
    );

    const button = screen.getByRole('button', { name: 'Create task' });
    expect(button).toHaveClass('si-button', 'si-button--primary', 'si-button--pulse');
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveClass('si-button--outline');
  });

  it('renders display-tone buttons with square corners and display face', () => {
    render(
      <>
        <Button variant="primary" tone="display">Display primary</Button>
        <Button variant="outline" tone="display">Display outline</Button>
        <Button variant="ghost" tone="display">Display ghost</Button>
      </>
    );

    expect(screen.getByRole('button', { name: 'Display primary' })).toHaveClass(
      'si-button--primary',
      'si-button--display'
    );
    expect(screen.getByRole('button', { name: 'Display outline' })).toHaveClass(
      'si-button--outline',
      'si-button--display'
    );
    expect(screen.getByRole('button', { name: 'Display ghost' })).toHaveClass(
      'si-button--ghost',
      'si-button--display'
    );
  });

  it('composes card state and tilt classes', () => {
    render(
      <Card variant="pulse" state="ready" tilt={1} data-testid="card">
        Ready task
      </Card>
    );

    expect(screen.getByTestId('card')).toHaveClass('si-card--pulse', 'si-card--ready', 'si-card-tilt-1');
  });

  it('renders card container sections with canvas header', () => {
    render(
      <CardContainer variant="column" data-testid="card-container">
        <CardContainer.Header title="Mission Control" />
        <CardContainer.Content>Body copy</CardContainer.Content>
        <CardContainer.Actions>
          <Button variant="primary">Install</Button>
        </CardContainer.Actions>
      </CardContainer>
    );

    expect(screen.getByTestId('card-container')).toHaveClass('si-card-container', 'si-card-container--column');
    expect(screen.getByRole('heading', { name: 'Mission Control' })).toHaveClass('si-card-container__title');
    expect(screen.getByText('Body copy').closest('.si-card-container__content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install' }).closest('.si-card-container__actions')).toBeInTheDocument();
  });

  it('renders filter card container variant', () => {
    render(
      <CardContainer variant="filter" data-testid="filter-container">
        <CardContainer.Content>Filters</CardContainer.Content>
      </CardContainer>
    );

    expect(screen.getByTestId('filter-container')).toHaveClass('si-card-container--filter');
  });

  it('renders form, badge, dropdown, avatar, and toast primitives', () => {
    render(
      <>
        <Field label="Title">
          <Input aria-label="Title" />
        </Field>
        <Badge variant="urgent">urgent</Badge>
        <Tooltip>3</Tooltip>
        <DropdownOption type="button">Open</DropdownOption>
        <Avatar aria-label="Assignee Q">Q</Avatar>
        <Toast type="success" title="Saved" />
      </>
    );

    expect(screen.getByText('Title')).toHaveClass('si-field__label');
    expect(screen.getByLabelText('Title')).toHaveClass('si-input');
    expect(screen.getByText('urgent')).toHaveClass('si-badge--urgent');
    expect(screen.getByText('3')).toHaveClass('si-tooltip');
    expect(screen.getByRole('button', { name: 'Open' })).toHaveClass('si-dropdown__option');
    expect(screen.getByLabelText('Assignee Q')).toHaveClass('si-avatar');
    expect(screen.getByText('Saved')).toHaveClass('si-toast__title');
    expect(screen.getByText('Saved').closest('.si-toast')).toHaveClass('si-toast--success');
  });

  describe('Avatar', () => {
    it('renders children text when no src is provided', () => {
      render(<Avatar aria-label="Assignee Q">Q</Avatar>);
      const avatar = screen.getByLabelText('Assignee Q');
      expect(avatar).toHaveClass('si-avatar');
      expect(avatar).toHaveTextContent('Q');
      expect(avatar.querySelector('img')).toBeNull();
    });

    it('renders an <img> with src and alt when src is provided', () => {
      render(<Avatar src="/avatars/quinn.png" alt="Quinn" aria-label="Assignee Quinn" />);
      const avatar = screen.getByLabelText('Assignee Quinn');
      const img = avatar.querySelector('img');
      expect(img).not.toBeNull();
      expect(img).toHaveClass('si-avatar__img');
      expect(img).toHaveAttribute('src', '/avatars/quinn.png');
      expect(img).toHaveAttribute('alt', 'Quinn');
    });

    it('falls back to children when the image fails to load', () => {
      render(<Avatar src="/missing.png" alt="Quinn" aria-label="Assignee Quinn">Q</Avatar>);
      const avatar = screen.getByLabelText('Assignee Quinn');
      const img = avatar.querySelector('img');
      expect(img).not.toBeNull();
      fireEvent.error(img);
      // After error, the children render and the img is gone.
      expect(avatar.querySelector('img')).toBeNull();
      expect(avatar).toHaveTextContent('Q');
    });
  });

  it('renders dashed and subtle dividers', () => {
    const { container } = render(
      <>
        <Divider variant="dashed" data-testid="dashed-divider" />
        <Divider variant="subtle" data-testid="subtle-divider" />
      </>
    );

    expect(container.querySelector('[data-testid="dashed-divider"]')).toHaveClass('si-divider--dashed');
    expect(container.querySelector('[data-testid="subtle-divider"]')).toHaveClass('si-divider--subtle');
  });

  it('renders brand-kit components inside a data-si-pack="brand" shell', () => {
    render(
      <div data-si-pack="brand">
        <Button as="a" variant="primary" href="https://example.com">Follow on X</Button>
        <Badge as="a" href="https://example.com/source">Canonical source</Badge>
        <Card as="button" type="button" interactive variant="default" aria-label="Open story">
          Story card
        </Card>
        <Card variant="ink" data-testid="ink-card">Dark panel</Card>
      </div>
    );

    const cta = screen.getByRole('link', { name: 'Follow on X' });
    expect(cta).toHaveClass('si-button', 'si-button--primary');
    expect(cta).toHaveAttribute('href', 'https://example.com');
    const chip = screen.getByRole('link', { name: 'Canonical source' });
    expect(chip).toHaveClass('si-badge');
    expect(chip).toHaveAttribute('href', 'https://example.com/source');
    expect(screen.getByRole('button', { name: 'Open story' })).toHaveClass('si-card', 'si-card--interactive');
    expect(screen.getByTestId('ink-card')).toHaveClass('si-card--ink');
  });

  it('renders search and filter controls from design-system classes', () => {
    render(
      <>
        <SearchInput label="Search tasks" placeholder="Search" />
        <Button variant="filter" active>
          Status: Ready
        </Button>
      </>
    );

    expect(screen.getByLabelText('Search tasks')).toHaveClass('si-search__input');
    expect(screen.getByRole('button', { name: 'Status: Ready' })).toHaveClass('si-button--filter', 'is-active');
  });
});
