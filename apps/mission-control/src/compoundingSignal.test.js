import { describe, it, expect } from 'vitest';
import {
  bandFor,
  classifySignalResponse,
  formatHeadline,
  isStale,
  SCHEMA_VERSION,
  SIGNAL_STATUS,
  STALE_AFTER_DAYS,
  subtitleFor,
  validateSignal
} from './compoundingSignal.js';

function makeSignal(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: '2026-08-17T20:15:00Z',
    generatedAt: '2026-08-17T20:15:00Z',
    asOf: '2026-08-17T20:15:00Z',
    headlinePercentage: 37.5,
    currentWindow: {
      start: '2026-08-10T20:15:00Z',
      end: '2026-08-17T20:15:00Z',
      eligibleCount: 8,
      referencedCount: 3,
      percentage: 37.5,
      dossierPromotionCount: 2
    },
    trend: [
      { offsetWeeks: 0, start: '2026-08-10T20:15:00Z', end: '2026-08-17T20:15:00Z', eligibleCount: 8, referencedCount: 3, percentage: 37.5 },
      { offsetWeeks: 1, start: '2026-08-03T20:15:00Z', end: '2026-08-10T20:15:00Z', eligibleCount: 6, referencedCount: 1, percentage: 16.7 },
      { offsetWeeks: 2, start: '2026-07-27T20:15:00Z', end: '2026-08-03T20:15:00Z', eligibleCount: 5, referencedCount: 1, percentage: 20.0 },
      { offsetWeeks: 3, start: '2026-07-20T20:15:00Z', end: '2026-07-27T20:15:00Z', eligibleCount: 4, referencedCount: 0, percentage: 0.0 }
    ],
    operatorNote: null,
    decisionPolicy: {
      lowPercentageBelow: 25.0,
      corpusEstablishedDocuments: 25,
      minimumFourWeekEligibleItemsForBrokenPath: 10
    },
    inputs: {
      bookmarkState: { path: 'x' },
      corpusIndex: { path: 'y' },
      dossierPromotions: { path: 'z' }
    },
    ...overrides
  };
}

describe('classifySignalResponse', () => {
  it('treats 404 as missing', () => {
    expect(classifySignalResponse(404, '')).toEqual({
      status: SIGNAL_STATUS.MISSING,
      signal: null,
      error: null
    });
  });

  it('classifies valid JSON as valid', () => {
    const result = classifySignalResponse(200, JSON.stringify(makeSignal()));
    expect(result.status).toBe(SIGNAL_STATUS.VALID);
    expect(result.signal.headlinePercentage).toBe(37.5);
  });

  it('treats 500 as malformed with HTTP error', () => {
    const result = classifySignalResponse(500, '');
    expect(result.status).toBe(SIGNAL_STATUS.MALFORMED);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('treats invalid JSON as malformed with parse error', () => {
    const result = classifySignalResponse(200, 'not json');
    expect(result.status).toBe(SIGNAL_STATUS.MALFORMED);
    expect(result.error).toMatch(/JSON parse error/);
  });

  it('treats schema-invalid payload as malformed', () => {
    const bad = { schemaVersion: 99, headlinePercentage: 0 };
    const result = classifySignalResponse(200, JSON.stringify(bad));
    expect(result.status).toBe(SIGNAL_STATUS.MALFORMED);
    expect(result.error).toMatch(/schemaVersion/);
  });
});

describe('validateSignal', () => {
  it('accepts a valid signal', () => {
    expect(validateSignal(makeSignal()).ok).toBe(true);
  });

  it('rejects wrong schemaVersion', () => {
    const result = validateSignal(makeSignal({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schemaVersion/);
  });

  it('rejects wrong trend length', () => {
    const signal = makeSignal();
    signal.trend = signal.trend.slice(0, 3);
    const result = validateSignal(signal);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exactly 4/);
  });

  it('rejects headline mismatch', () => {
    const result = validateSignal(makeSignal({ headlinePercentage: 99.9 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/headlinePercentage/);
  });

  it('accepts null headline (zero-denominator window)', () => {
    const signal = makeSignal();
    signal.trend.forEach((w) => (w.percentage = null));
    signal.headlinePercentage = null;
    expect(validateSignal(signal).ok).toBe(true);
  });

  it('rejects referencedCount exceeding eligibleCount', () => {
    const signal = makeSignal();
    signal.trend[0].referencedCount = 999;
    const result = validateSignal(signal);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/referencedCount/);
  });

  it('rejects non-string operatorNote id', () => {
    const signal = makeSignal();
    signal.operatorNote = { id: 123, text: 'x' };
    const result = validateSignal(signal);
    expect(result.ok).toBe(false);
  });
});

describe('isStale', () => {
  it('returns true when generatedAt is more than STALE_AFTER_DAYS days ago', () => {
    const long_ago = new Date(Date.now() - (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const signal = makeSignal({ generatedAt: long_ago });
    expect(isStale(signal)).toBe(true);
  });

  it('returns false when generatedAt is within the freshness window', () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const signal = makeSignal({ generatedAt: recent });
    expect(isStale(signal)).toBe(false);
  });

  it('returns true for missing or unparseable generatedAt', () => {
    expect(isStale(null)).toBe(true);
    expect(isStale({})).toBe(true);
    expect(isStale({ generatedAt: 'not-a-date' })).toBe(true);
  });
});

describe('bandFor', () => {
  it('returns green for >= 50', () => {
    expect(bandFor(50)).toBe('green');
    expect(bandFor(75)).toBe('green');
  });

  it('returns amber for 25-49.9', () => {
    expect(bandFor(25)).toBe('amber');
    expect(bandFor(49.9)).toBe('amber');
  });

  it('returns red for < 25', () => {
    expect(bandFor(24.9)).toBe('red');
    expect(bandFor(0)).toBe('red');
  });

  it('returns neutral for null', () => {
    expect(bandFor(null)).toBe('neutral');
    expect(bandFor(undefined)).toBe('neutral');
  });
});

describe('subtitleFor', () => {
  it('returns "x/y referenced · n dossier promotions"', () => {
    const signal = makeSignal();
    expect(subtitleFor(signal)).toBe('3/8 referenced · 2 dossier promotions');
  });

  it('returns empty string for null signal', () => {
    expect(subtitleFor(null)).toBe('');
  });

  it('defaults dossier promotions to 0 when currentWindow is missing', () => {
    const signal = makeSignal();
    delete signal.currentWindow;
    expect(subtitleFor(signal)).toBe('3/8 referenced · 0 dossier promotions');
  });
});

describe('formatHeadline', () => {
  it('formats non-null as one-decimal percent', () => {
    expect(formatHeadline(37.5)).toBe('37.5%');
    expect(formatHeadline(50)).toBe('50.0%');
  });

  it('returns em-dash for null', () => {
    expect(formatHeadline(null)).toBe('—');
    expect(formatHeadline(undefined)).toBe('—');
  });
});
