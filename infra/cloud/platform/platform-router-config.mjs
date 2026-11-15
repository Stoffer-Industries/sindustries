#!/usr/bin/env node
/**
 * platform-router-config.mjs — render the in-container nginx router for
 * one platform environment.
 *
 * The router topology (upstreams, status route, path-prefix fallback)
 * is shared. The hostnames it serves are environment-owned and live in
 * the platform environment manifest. Keeping the hostnames in the
 * static nginx file would make the production image serve the staging
 * hostnames, so the static file is a template and this module fills it
 * from the manifest before the supervisor starts nginx.
 *
 * THE RENDER IS A BOUNDARY
 * -----------------------
 * nginx has no escaping inside `server_name`, nor inside the
 * single-quoted string of a `return` body: a value carrying a quote, a
 * semicolon or whitespace ends the directive it appears in and starts
 * another one. The manifest is repo-owned today, but this module is the
 * place where that stays true — so every value it interpolates is
 * checked to be a plain hostname first, and the replacement is done
 * with a function so a `$&` or `$'` inside a value cannot expand.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getPlatformEnvironment } from './platform-environments.mjs';

/**
 * A plain hostname: DNS labels of letters, digits and hyphens joined by
 * dots. Nothing else — no quotes, no semicolons, no whitespace, no
 * nginx punctuation.
 */
const PLAIN_HOSTNAME =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Assert that a value is safe to interpolate into the nginx config.
 *
 * @param {string} value
 * @param {string} label what the value is, for the error message
 * @returns {string} the value, unchanged
 * @throws {Error} when the value is not a plain hostname
 */
export function assertSafeHostValue(value, label) {
  const host = String(value ?? '');
  if (!PLAIN_HOSTNAME.test(host)) {
    throw new Error(
      `refusing to render the nginx router: ${label} ("${host}") is not a plain hostname`,
    );
  }
  return host;
}

const REPLACEMENTS_BY_ENVIRONMENT = {
  __TASKS_API_HOST__: (environment) =>
    assertSafeHostValue(
      new URL(environment.apiBaseUrls.tasksApi).hostname,
      'the tasks API hostname',
    ),
  __BUDGET_API_HOST__: (environment) =>
    assertSafeHostValue(
      new URL(environment.apiBaseUrls.budgetApi).hostname,
      'the budget API hostname',
    ),
  __CONTENT_SCHEDULER_API_HOST__: (environment) =>
    assertSafeHostValue(
      new URL(environment.apiBaseUrls.contentSchedulerApi).hostname,
      'the content scheduler API hostname',
    ),
  __PLATFORM_PROVIDER_HOST__: (environment) =>
    assertSafeHostValue(
      `${assertSafeHostValue(environment.platformApp, 'the platform app name')}.fly.dev`,
      'the platform provider hostname',
    ),
  __PLATFORM_APP__: (environment) =>
    assertSafeHostValue(environment.platformApp, 'the platform app name'),
};

/**
 * Render the nginx router configuration for an environment.
 *
 * @param {string} environmentId
 * @param {string} templateText
 * @returns {string}
 */
export function renderRouterConfig(environmentId, templateText) {
  const environment = getPlatformEnvironment(environmentId);
  let rendered = templateText;

  for (const [token, resolve] of Object.entries(REPLACEMENTS_BY_ENVIRONMENT)) {
    if (!rendered.includes(token)) {
      throw new Error(`nginx router template is missing the ${token} placeholder`);
    }
    // A FUNCTION replacement, not a string one: with a string
    // replacement, a `$&` or `$'` inside the value is expanded by
    // replaceAll and the rendered config would differ from the manifest.
    rendered = rendered.replaceAll(token, () => resolve(environment));
  }

  const unresolved = rendered.match(/__[A-Z0-9_]+__/g);
  if (unresolved) {
    throw new Error(`nginx router template has unresolved placeholders: ${unresolved.join(', ')}`);
  }
  return rendered;
}

/**
 * Write the rendered router configuration to disk.
 *
 * The write is ATOMIC: the config is written beside its destination and
 * renamed into place, so a process killed mid-write cannot leave a
 * truncated config at the path nginx is about to read.
 *
 * @param {{environmentId: string, templatePath: string, outputPath: string}} options
 * @returns {string} the output path
 */
export function writeRouterConfig({ environmentId, templatePath, outputPath }) {
  const rendered = renderRouterConfig(
    environmentId,
    readFileSync(templatePath, 'utf8'),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  writeFileSync(temporaryPath, rendered, 'utf8');
  renameSync(temporaryPath, outputPath);
  return outputPath;
}
