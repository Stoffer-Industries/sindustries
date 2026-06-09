import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, Badge, Button, Card, CardContainer, DropdownOption, Field, Input, SearchInput, Toast } from './index.jsx';

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
        <DropdownOption type="button">Open</DropdownOption>
        <Avatar aria-label="Assignee Q">Q</Avatar>
        <Toast type="success">Saved</Toast>
      </>
    );

    expect(screen.getByText('Title')).toHaveClass('si-field__label');
    expect(screen.getByLabelText('Title')).toHaveClass('si-input');
    expect(screen.getByText('urgent')).toHaveClass('si-badge--urgent');
    expect(screen.getByRole('button', { name: 'Open' })).toHaveClass('si-dropdown__option');
    expect(screen.getByLabelText('Assignee Q')).toHaveClass('si-avatar');
    expect(screen.getByText('Saved')).toHaveClass('si-toast--success');
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
