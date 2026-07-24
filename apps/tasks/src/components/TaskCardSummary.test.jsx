import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCardSummary } from './TaskCardSummary.jsx';
import { ASSIGNEE_USERS } from '../users/assignees.js';

function makeRegistryClone(overrides) {
  return ASSIGNEE_USERS.map((user) => {
    const override = overrides?.[user.id];
    return override ? { ...user, ...override } : { ...user };
  });
}

describe('TaskCardSummary', () => {
  it('copies the task ID without triggering the title click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const onTitleClick = vi.fn();

    render(
      <TaskCardSummary
        task={{
          id: 'task-123',
          title: 'Copy target',
          priority: 'medium',
          status: 'ready',
          tags: []
        }}
        onTitleClick={onTitleClick}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID task-123' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('task-123'));
    expect(screen.getByRole('button', { name: 'Copy task ID task-123' })).toHaveTextContent('Copied');
    expect(onTitleClick).not.toHaveBeenCalled();
  });

  describe('AC2 — fallback to the current first-letter rendering', () => {
    it('renders the initial for a known user when avatarSrc is null (override sets it null)', () => {
      vi.resetModules();
      const clone = makeRegistryClone({ quinn: { avatarSrc: null } });
      vi.doMock('../users/assignees.js', () => ({
        ASSIGNEE_USERS: clone,
        ASSIGNEE_OPTIONS: clone.map((user) => user.displayName),
        findAssigneeUser: (assignee) => {
          const id = typeof assignee === 'string' ? assignee.trim().toLowerCase() : '';
          return clone.find((user) => user.id === id) ?? null;
        },
        assigneeDisplayName: (assignee) => {
          const id = typeof assignee === 'string' ? assignee.trim().toLowerCase() : '';
          const user = clone.find((user) => user.id === id);
          if (user) return user.displayName;
          if (typeof assignee === 'string' && assignee.trim()) return assignee.trim();
          return '';
        }
      }));

      return import('./TaskCardSummary.jsx').then(({ TaskCardSummary: TaskCardSummaryReloaded }) => {
        render(
          <TaskCardSummaryReloaded
            task={{
              id: 'task-ac2',
              title: 'Avatar fallback (known)',
              priority: 'medium',
              status: 'ready',
              assignee: 'Quinn',
              tags: []
            }}
          />
        );

        const avatar = screen.getByLabelText('Assignee Quinn');
        expect(avatar).toHaveClass('si-avatar');
        expect(avatar).toHaveTextContent('Q');
        // No <img> should render when avatarSrc is null.
        expect(avatar.querySelector('img')).toBeNull();
      });
    });

    it('renders the initial for an unknown free-form assignee', () => {
      render(
        <TaskCardSummary
          task={{
            id: 'task-unknown',
            title: 'Unknown assignee',
            priority: 'medium',
            status: 'ready',
            assignee: 'someone-new',
            tags: []
          }}
        />
      );

      const avatar = screen.getByLabelText('Assignee someone-new');
      expect(avatar).toHaveClass('si-avatar');
      expect(avatar).toHaveTextContent('S');
      expect(avatar.querySelector('img')).toBeNull();
    });

    it('omits the avatar entirely when the assignee is empty / whitespace', () => {
      const { container } = render(
        <TaskCardSummary
          task={{
            id: 'task-noassignee',
            title: 'No assignee',
            priority: 'medium',
            status: 'ready',
            assignee: '   ',
            tags: []
          }}
        />
      );

      expect(container.querySelector('.si-avatar')).toBeNull();
    });
  });

  describe('AC3 — display the known assignee display name instead of the raw id', () => {
    it('uses the display name in the aria-label when the assignee matches a known id (lowercase input)', () => {
      render(
        <TaskCardSummary
          task={{
            id: 'task-ac3',
            title: 'AC3 lowercase',
            priority: 'low',
            status: 'ready',
            assignee: 'quinn',
            tags: []
          }}
        />
      );

      expect(screen.getByLabelText('Assignee Quinn')).toBeInTheDocument();
    });

    it('falls back to the raw assignee label for unknown free-form assignees', () => {
      render(
        <TaskCardSummary
          task={{
            id: 'task-ac3-freeform',
            title: 'AC3 free-form',
            priority: 'low',
            status: 'ready',
            assignee: 'someone-new',
            tags: []
          }}
        />
      );

      expect(screen.getByLabelText('Assignee someone-new')).toBeInTheDocument();
    });
  });

  describe('AC1 — task cards show the assignee avatar image when one is set (test fixture)', () => {
    it('renders an <img> with src and alt when a registry clone sets avatarSrc', () => {
      vi.resetModules();
      vi.doMock('../users/assignees.js', () => {
        const clone = makeRegistryClone({ quinn: { avatarSrc: '/avatars/__test-fixture__.png' } });
        return {
          ASSIGNEE_USERS: clone,
          ASSIGNEE_OPTIONS: clone.map((user) => user.displayName),
          findAssigneeUser: (assignee) => {
            const id = typeof assignee === 'string' ? assignee.trim().toLowerCase() : '';
            return clone.find((user) => user.id === id) ?? null;
          },
          assigneeDisplayName: (assignee) => {
            const id = typeof assignee === 'string' ? assignee.trim().toLowerCase() : '';
            const user = clone.find((user) => user.id === id);
            if (user) return user.displayName;
            if (typeof assignee === 'string' && assignee.trim()) return assignee.trim();
            return '';
          }
        };
      });

      return import('./TaskCardSummary.jsx').then(({ TaskCardSummary: TaskCardSummaryReloaded }) => {
        render(
          <TaskCardSummaryReloaded
            task={{
              id: 'task-ac1',
              title: 'AC1 fixture',
              priority: 'low',
              status: 'ready',
              assignee: 'Quinn',
              tags: []
            }}
          />
        );

        const avatar = screen.getByLabelText('Assignee Quinn');
        const img = avatar.querySelector('img');
        expect(img).not.toBeNull();
        expect(img).toHaveAttribute('src', '/avatars/__test-fixture__.png');
        expect(img).toHaveAttribute('alt', 'Quinn');
      }).finally(() => {
        vi.doUnmock('../users/assignees.js');
        vi.resetModules();
      });
    });

    it('the production registry ships avatar image paths for every v1 user (fixture does not leak)', () => {
      for (const user of ASSIGNEE_USERS) {
        expect(user.avatarSrc).toMatch(new RegExp(`/avatars/${user.id}\\.(png|jpg)$`));
      }
    });
  });
});
