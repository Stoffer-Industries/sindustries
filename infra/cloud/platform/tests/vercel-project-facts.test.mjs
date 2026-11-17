import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { productionProjectFacts } from '../../scripts/vercel-project-facts.mjs';

test('production frontend facts are projected from the matrices', () => {
  const missionControl = productionProjectFacts('mission-control');
  assert.equal(missionControl.vercelProjectId, 'sindustries-mission-control');
  assert.equal(missionControl.appPath, 'apps/mission-control');
  assert.equal(missionControl.workspaceName, '@sindustries/mission-control');
  assert.equal(missionControl.customDomain, 'mission-control.sindustries.co.nz');
  assert.equal(missionControl.provisioned, true);

  const tasks = productionProjectFacts('tasks-app');
  assert.equal(tasks.vercelProjectId, 'sindustries-tasks');
  assert.equal(tasks.workspaceName, '@sindustries/tasks-app');
  assert.equal(tasks.customDomain, 'tasks.sindustries.co.nz');
});

test('unknown or non-frontend surfaces fail closed', () => {
  assert.throws(() => productionProjectFacts('tasks-api'), /unknown frontend surface/);
});
