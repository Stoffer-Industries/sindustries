import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createConfettiPieces,
  normalizeComments,
  formatCommentTimestamp,
  normalizeTaskForEditor,
  assigneeInitial,
  taskCardTilt
} from '../utils/helpers.js';

describe('helpers', () => {
  describe('createConfettiPieces', () => {
    it('creates default 120 pieces', () => {
      const pieces = createConfettiPieces();
      expect(pieces).toHaveLength(120);
    });

    it('creates specified number of pieces', () => {
      const pieces = createConfettiPieces(50);
      expect(pieces).toHaveLength(50);
    });

    it('each piece has required properties', () => {
      const pieces = createConfettiPieces(5);
      pieces.forEach((piece) => {
        expect(piece).toHaveProperty('id');
        expect(piece).toHaveProperty('color');
        expect(piece).toHaveProperty('startX');
        expect(piece).toHaveProperty('drift');
        expect(piece).toHaveProperty('rotation');
        expect(piece).toHaveProperty('size');
        expect(piece).toHaveProperty('duration');
        expect(piece).toHaveProperty('delay');
      });
    });

    it('pieces have valid numeric ranges', () => {
      const pieces = createConfettiPieces(10);
      pieces.forEach((piece) => {
        expect(piece.startX).toBeGreaterThanOrEqual(5);
        expect(piece.startX).toBeLessThan(95);
        expect(piece.size).toBeGreaterThanOrEqual(6);
        expect(piece.size).toBeLessThan(14);
        expect(piece.duration).toBeGreaterThanOrEqual(1200);
        expect(piece.duration).toBeLessThan(2500);
      });
    });
  });

  describe('normalizeComments', () => {
    it('returns empty array for null', () => {
      expect(normalizeComments(null)).toEqual([]);
    });

    it('returns empty array for undefined', () => {
      expect(normalizeComments(undefined)).toEqual([]);
    });

    it('returns array as-is', () => {
      const comments = [{ author: 'a', text: 'b' }];
      expect(normalizeComments(comments)).toBe(comments);
    });

    it('returns empty array for non-array', () => {
      expect(normalizeComments('not an array')).toEqual([]);
      expect(normalizeComments({})).toEqual([]);
    });
  });

  describe('formatCommentTimestamp', () => {
    it('returns empty string for null', () => {
      expect(formatCommentTimestamp(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(formatCommentTimestamp(undefined)).toBe('');
    });

    it('returns empty string for invalid date', () => {
      expect(formatCommentTimestamp('invalid-date')).toBe('');
    });

    it('formats ISO date string', () => {
      const result = formatCommentTimestamp('2024-01-15T10:30:00Z');
      expect(result).toContain('2024');
    });

    it('formats Date object', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const result = formatCommentTimestamp(date);
      expect(result).toContain('2024');
    });
  });

  describe('normalizeTaskForEditor', () => {
    it('returns default values for empty task', () => {
      const result = normalizeTaskForEditor({});
      expect(result.title).toBe('');
      expect(result.description).toBe('');
      expect(result.status).toBe('open');
      expect(result.priority).toBe('medium');
      expect(result.assignee).toBe('');
      expect(result.dueAt).toBe('');
      expect(result.tagsText).toBe('');
      expect(result.blocked).toBe(false);
    });

    it('preserves existing values', () => {
      const task = {
        title: 'Test Task',
        description: 'Description',
        status: 'done',
        priority: 'high',
        assignee: 'John',
        dueAt: '2024-01-15T00:00:00.000Z',
        tags: ['tag1', 'tag2'],
        blocked: true
      };
      const result = normalizeTaskForEditor(task);
      expect(result.title).toBe('Test Task');
      expect(result.description).toBe('Description');
      expect(result.status).toBe('done');
      expect(result.priority).toBe('high');
      expect(result.assignee).toBe('John');
      expect(result.dueAt).toBe('2024-01-15');
      expect(result.tagsText).toBe('tag1, tag2');
      expect(result.blocked).toBe(true);
    });

    it('handles tags with name property', () => {
      const task = { tags: [{ name: 'feature' }, { name: 'bug' }] };
      const result = normalizeTaskForEditor(task);
      expect(result.tagsText).toBe('feature, bug');
    });

    it('handles null values gracefully', () => {
      const task = { title: null, description: null, assignee: null };
      const result = normalizeTaskForEditor(task);
      expect(result.title).toBe('');
      expect(result.description).toBe('');
      expect(result.assignee).toBe('');
    });
  });

  describe('assigneeInitial', () => {
    it('returns null for null', () => {
      expect(assigneeInitial(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(assigneeInitial(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(assigneeInitial('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(assigneeInitial('   ')).toBeNull();
    });

    it('returns uppercase first character', () => {
      expect(assigneeInitial('john')).toBe('J');
    });

    it('handles already uppercase', () => {
      expect(assigneeInitial('John')).toBe('J');
    });

    it('trims whitespace', () => {
      expect(assigneeInitial('  john  ')).toBe('J');
    });
  });

  describe('taskCardTilt', () => {
    it('returns a stable bucket between 0 and 2', () => {
      expect(taskCardTilt('assigned')).toBe(taskCardTilt('assigned'));
      expect(taskCardTilt('assigned')).toBeGreaterThanOrEqual(0);
      expect(taskCardTilt('assigned')).toBeLessThan(3);
    });
  });
});