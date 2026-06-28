// Constants extracted from tasks.ts to keep the route module focused on
// HTTP wiring. Pure constants only — no side effects.

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 10000;

export const validStatuses = new Set(['open', 'ready', 'doing', 'acceptance', 'done']);
export const validPriorities = new Set(['low', 'medium', 'high', 'urgent']);
export const validAssignees = new Set(['Tom', 'Quinn', 'Rowan', 'Lox', 'Ivy']);
export const validSorts = new Set(['priority', 'createdAt', 'updatedAt', 'dueAt', 'statusChangedAt']);
export const validTaskTypes = new Set(['content', 'code', 'research', 'feature']);

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const taskTypeTitlePrefixes = {
  content: '✍️',
  code: '💻',
  research: '🔎',
  feature: '🔧'
};

export const priorityOrder = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3
};

export const dependencyInclude = {
  dependencies: {
    include: {
      dependsOn: {
        select: {
          id: true,
          title: true,
          status: true,
          completedAt: true
        }
      }
    }
  }
};
