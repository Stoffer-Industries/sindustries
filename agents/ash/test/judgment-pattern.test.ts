/**
 * judgment-pattern.test.ts — doc-test for the prompt-driven verification
 * pattern introduced by task 0b16dc37.
 *
 * Judgment is an LLM property, not a code property — there is no live
 * `judgeIntent` to exercise in unit tests. What this file does assert is
 * that Ash's prompt/orchestration surfaces (HEARTBEAT.md, WORKFLOW.md,
 * SOUL.md, DoD.md) describe the reasoning-and-deferral pattern correctly.
 *
 * If a future change to those files removes the reasoning loop, the
 * capability-gap convention, or the two-strike rule, this test fails —
 * even though no live behavior is asserted.
 *
 * Per `docs/specs/ash-prompt-driven-verifier-tech-design.md` (WS3 + AC2/AC5).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS_DIR = resolve(__dirname, '../../definitions/ash');

function readDoc(filename: string): string {
  return readFileSync(resolve(DOCS_DIR, filename), 'utf8');
}

describe('Ash HEARTBEAT.md describes the reasoning loop', () => {
  const hb = readDoc('HEARTBEAT.md');

  it('references the reasoning loop over PR diff + cited tests + cited files', () => {
    expect(hb).toMatch(/reason(ing)? over/i);
    // No CLI invocation language — Ash is not invoked through a CLI
    // function anymore (task 0b16dc37).
    expect(hb).not.toMatch(/run.*verify\.ts|tsx src|verify\.ts CLI/i);
  });

  it('defines the [qa-agent-verified] / [qa-agent-blocked] / [qa-agent-deferred] conventions', () => {
    expect(hb).toContain('[qa-agent-verified]');
    expect(hb).toContain('[qa-agent-blocked]');
    expect(hb).toContain('[qa-agent-deferred]');
  });

  it('describes the two-strike rule for capability-gap follow-up tasks', () => {
    expect(hb).toMatch(/two.{0,5}strike|second.{0,10}deferral/i);
  });

  it('requires the structured qa_agent approval on a clean run', () => {
    // Use [\s\S] instead of . so the regex matches across newlines
    // (the approval sentence wraps onto two lines in the markdown).
    expect(hb).toMatch(/structured[\s\S]*?qa_agent[\s\S]*?approval/i);
  });
});

describe('Ash WORKFLOW.md describes the reasoning loop', () => {
  const wf = readDoc('WORKFLOW.md');

  it('replaces the CLI-invocation step with a reasoning loop description', () => {
    expect(wf).not.toMatch(/run the verifier in.*verify\.ts/i);
    expect(wf).toMatch(/reason(ing)? over/i);
  });

  it('preserves the routing semantics (gate context, attention stack, escalation)', () => {
    expect(wf).toContain('attentionOwners');
    expect(wf).toContain('workflowGates');
    expect(wf).toMatch(/Quinn is the highest agent escalation/i);
  });
});

describe('Ash SOUL.md names the reasoning + deferral role', () => {
  const soul = readDoc('SOUL.md');

  it('keeps the Principal Quality Engineer framing', () => {
    expect(soul).toMatch(/Principal Quality Engineer/i);
  });

  it('explicitly describes the judgment surface as reasoning, not text/token matching', () => {
    expect(soul).toMatch(/reason(ing)? over/i);
    expect(soul).toMatch(/defer/i);
  });
});

describe('Ash DoD.md adds the capability-gap deferral bullet', () => {
  const dod = readDoc('DoD.md');

  it('preserves the existing structured-approval + routing semantics', () => {
    expect(dod).toContain('qa_agent');
    expect(dod).toContain('attentionOwners');
  });

  it('names the capability-gap deferral as a first-class outcome', () => {
    expect(dod).toMatch(/deferr?al|capability gap/i);
  });
});

describe('verify.ts has no bespoke judgment code', () => {
  it('does not export defaultJudgeIntent, verifySemantic, runCli, or Deps.judgeIntent', async () => {
    const src = readFileSync(resolve(__dirname, '../src/verify.ts'), 'utf8');
    // Function-shaped references only — comments that *mention* the
    // removed placeholder (in the file's scope description) are fine
    // and historically accurate.
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+defaultJudgeIntent/);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+verifySemantic/);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+runCli/);
    expect(src).not.toMatch(/judgeIntent/);
  });

  it('does export the surviving utility surface', async () => {
    const src = readFileSync(resolve(__dirname, '../src/verify.ts'), 'utf8');
    expect(src).toMatch(/export function extractAcLines/);
    expect(src).toMatch(/export function stripTrailingEvidence/);
    expect(src).toMatch(/export async function fetchPrSummary/);
  });

  it('removes the package.json `verify` CLI script', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.verify).toBeUndefined();
  });
});
