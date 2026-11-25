import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tasksFrameAncestors } from '../vite.config.js';

const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));

describe('Tasks embedding policy', () => {
  it('allows only the production and staging Mission Control origins', () => {
    const headers = vercel.headers.flatMap((entry) => entry.headers);
    const csp = headers.find((entry) => entry.key === 'Content-Security-Policy')?.value;
    expect(csp).toBe('frame-ancestors https://mission-control.sindustries.co.nz https://mission-control.staging.sindustries.co.nz');
    expect(csp).not.toContain('*');
    expect(headers.some((entry) => entry.key.toLowerCase() === 'x-frame-options')).toBe(false);
  });

  it('uses only the exact local shell origin in Vite development', () => {
    expect(tasksFrameAncestors()).toBe('frame-ancestors http://localhost:5176');
    expect(tasksFrameAncestors('http://localhost:6000')).toBe('frame-ancestors http://localhost:6000');
  });
});
