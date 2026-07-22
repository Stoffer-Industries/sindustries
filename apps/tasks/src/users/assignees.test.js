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
        // avatarSrc is optional in the shape; v1 ships with null but the field stays for the follow-up task.
        expect(Object.prototype.hasOwnProperty.call(user, 'avatarSrc')).toBe(true);
      }
    });

    it('findAssigneeUser returns the user for a known id (lowercase, trimmed)', () => {
      expect(findAssigneeUser('quinn')).toEqual({ id: 'quinn', displayName: 'Quinn', avatarSrc: null });
      expect(findAssigneeUser('  ivy  ')).toEqual({ id: 'ivy', displayName: 'Ivy', avatarSrc: null });
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

  describe('AC6 — v1 ships with all avatars unset (no avatar image files in this task)', () => {
    it('every v1 record has avatarSrc === null', () => {
      for (const user of ASSIGNEE_USERS) {
        expect(user.avatarSrc).toBeNull();
      }
    });
  });
});
