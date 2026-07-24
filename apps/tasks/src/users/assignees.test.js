import { describe, expect, it } from 'vitest';
import {
  ASSIGNEE_USERS,
  ASSIGNEE_OPTIONS,
  assigneeDisplayName,
  findAssigneeUser
} from './assignees.js';

describe('assignee registry', () => {
  describe('AC4 — shared user model maps id to display name and optional avatar', () => {
    it('exposes a record shape with id, displayName, avatarSrc', () => {
      for (const user of ASSIGNEE_USERS) {
        expect(typeof user.id).toBe('string');
        expect(typeof user.displayName).toBe('string');
        // avatarSrc is set for every v1 user — points at apps/tasks/public/avatars/<id>.{png,jpg}.
        expect(Object.prototype.hasOwnProperty.call(user, 'avatarSrc')).toBe(true);
        expect(typeof user.avatarSrc).toBe('string');
      }
    });

    it('findAssigneeUser returns the user for a known id (lowercase, trimmed)', () => {
      expect(findAssigneeUser('quinn')).toEqual({ id: 'quinn', displayName: 'Quinn', avatarSrc: '/avatars/quinn.png' });
      expect(findAssigneeUser('  ivy  ')).toEqual({ id: 'ivy', displayName: 'Ivy', avatarSrc: '/avatars/ivy.png' });
    });

    it('findAssigneeUser is case-insensitive against display-name capitalization', () => {
      expect(findAssigneeUser('Quinn')?.id).toBe('quinn');
      expect(findAssigneeUser('QUINN')?.id).toBe('quinn');
      expect(findAssigneeUser('ToM')?.id).toBe('tom');
    });

    it('findAssigneeUser returns null for unknown / empty input', () => {
      expect(findAssigneeUser('someone-new')).toBeNull();
      expect(findAssigneeUser('')).toBeNull();
      expect(findAssigneeUser('   ')).toBeNull();
      expect(findAssigneeUser(null)).toBeNull();
      expect(findAssigneeUser(undefined)).toBeNull();
      expect(findAssigneeUser(42)).toBeNull();
    });

    it('assigneeDisplayName returns the display name for known ids', () => {
      expect(assigneeDisplayName('quinn')).toBe('Quinn');
      expect(assigneeDisplayName('Quinn')).toBe('Quinn');
      expect(assigneeDisplayName('TOM')).toBe('Tom');
    });

    it('assigneeDisplayName falls back to the trimmed raw assignee for unknown input', () => {
      expect(assigneeDisplayName('someone-new')).toBe('someone-new');
      expect(assigneeDisplayName('  someone-new  ')).toBe('someone-new');
    });

    it('assigneeDisplayName returns an empty string for missing / whitespace-only input', () => {
      expect(assigneeDisplayName('')).toBe('');
      expect(assigneeDisplayName('   ')).toBe('');
      expect(assigneeDisplayName(null)).toBe('');
      expect(assigneeDisplayName(undefined)).toBe('');
    });
  });

  describe('AC5 — v1 records exist for Quinn, Ivy, Lox, Rowan, Tom', () => {
    it('contains the expected ids in lowercase', () => {
      const ids = ASSIGNEE_USERS.map((user) => user.id);
      expect(ids).toEqual(expect.arrayContaining(['quinn', 'ivy', 'lox', 'rowan', 'tom']));
      expect(ids).toHaveLength(5);
    });

    it('contains the expected display names', () => {
      const names = ASSIGNEE_USERS.map((user) => user.displayName);
      expect(names).toEqual(expect.arrayContaining(['Quinn', 'Ivy', 'Lox', 'Rowan', 'Tom']));
    });

    it('exposes the same names via ASSIGNEE_OPTIONS for backwards-compatible dropdowns', () => {
      expect(ASSIGNEE_OPTIONS).toEqual(['Quinn', 'Ivy', 'Lox', 'Rowan', 'Tom']);
    });
  });

  describe('AC6 — v1 ships with avatar image files for every agent', () => {
    it('every v1 record points avatarSrc at /avatars/<id>.{png,jpg}', () => {
      for (const user of ASSIGNEE_USERS) {
        expect(user.avatarSrc).toMatch(new RegExp(`/avatars/${user.id}\\.(png|jpg)$`));
      }
    });
  });
});
