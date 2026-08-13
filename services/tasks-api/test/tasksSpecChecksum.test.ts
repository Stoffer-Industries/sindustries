import { describe, expect, it } from 'vitest';
import {
  descriptionHasSpecDrift,
  specChecksumForDescription
} from '../src/routes/tasks/_spec.ts';

function taskFixture(overrides: Partial<{ description: string | null; specChecksum: string | null }> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    description: null,
    specChecksum: null,
    ...overrides
  };
}

describe('descriptionHasSpecDrift', () => {
  it('returns false when there is no stored specChecksum', () => {
    const task = taskFixture({
      description: '## Acceptance Criteria\n- [ ] AC1\n',
      specChecksum: null
    });
    expect(descriptionHasSpecDrift(task, task.description ?? '')).toBe(false);
  });

  it('returns true when the proposed description produces a different checksum', () => {
    const originalDescription = '## Acceptance Criteria\n- [ ] AC1\n';
    const storedChecksum = specChecksumForDescription(originalDescription);
    const task = taskFixture({
      description: originalDescription,
      specChecksum: storedChecksum
    });
    const driftedDescription = '## Acceptance Criteria\n- [ ] AC1\n- [ ] AC2\n';
    expect(descriptionHasSpecDrift(task, driftedDescription)).toBe(true);
  });

  it('returns false when the proposed description produces the same checksum', () => {
    const description = '## Acceptance Criteria\n- [ ] AC1\n';
    const task = taskFixture({
      description,
      specChecksum: specChecksumForDescription(description)
    });
    expect(descriptionHasSpecDrift(task, description)).toBe(false);
  });

  // Per task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` AC2: the Tasks API no
  // longer treats the legacy `- [x] **Approved by Tom**` marker as runtime
  // state. A marker-only edit (Tom toggling the checkbox without changing
  // any AC text) does NOT produce checksum drift here — the AC text is
  // identical so the canonical form is identical. The marker is now an inert
  // line in the description; approval state lives in `TaskApproval` rows.
  // Re-issue approval via the structured endpoint after editing ACs.
  it('marker-only edits do not produce checksum drift (AC2: marker is inert)', () => {
    const description = [
      '## Outcome',
      '',
      '- [x] **Approved by Tom**',
      '',
      '## Acceptance Criteria',
      '- [ ] AC1'
    ].join('\n');
    const task = taskFixture({
      description,
      specChecksum: specChecksumForDescription(description)
    });
    const uncheckedMarker = description.replace('- [x] **Approved by Tom**', '- [ ] **Approved by Tom**');
    expect(descriptionHasSpecDrift(task, uncheckedMarker)).toBe(false);
    expect(specChecksumForDescription(description)).toBe(
      specChecksumForDescription('## Outcome\n\n## Acceptance Criteria\n- [ ] AC1')
    );
  });
});
