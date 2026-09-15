#!/usr/bin/env node
// check-schema.mjs — minimal structural validator for
// tests/cloud/staging-validation.schema.json. No deps; exists so CI can
// run `node scripts/check-schema.mjs path/to/result.json` without
// pulling in ajv for a single-file schema check. Walks required
// fields, enums, and simple string patterns; deep validation lives
// in the downstream operator review of the redacted evidence doc.
//
// Usage:
//   node scripts/check-schema.mjs <result.json> [<schema.json>]

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';

const DEFAULTS = {
  schema: new URL('../staging-validation.schema.json', import.meta.url).pathname
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { result: null, schema: DEFAULTS.schema };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      stdout.write('Usage: node scripts/check-schema.mjs <result.json> [<schema.json>]\n');
      exit(0);
    }
    if (out.result === null) out.result = a;
    else out.schema = a;
  }
  if (out.result === null) {
    stderr.write('error: missing required argument: <result.json>\n');
    exit(2);
  }
  return out;
}

const errors = [];

function expect(cond, message) {
  if (!cond) errors.push(message);
}

function walk(schemaNode, instance, path) {
  if (schemaNode === undefined || schemaNode === true) return;
  if (schemaNode === false) {
    errors.push(`${path}: schema disallows any value`);
    return;
  }
  if (typeof schemaNode !== 'object') return;
  if (Array.isArray(schemaNode)) {
    if (!Array.isArray(instance)) {
      errors.push(`${path}: expected array`);
      return;
    }
    const itemSchema = schemaNode[0];
    instance.forEach((item, idx) => walk(itemSchema, item, `${path}[${idx}]`));
    return;
  }
  if (instance === undefined || instance === null) {
    if (schemaNode.required === true || schemaNode.const !== undefined) {
      errors.push(`${path}: required value missing`);
    }
    return;
  }
  // Validate type. JSON Schema type may be a string or array; we only
  // need the basics for the staging-validation schema.
  if (typeof schemaNode.type === 'string') {
    const t = schemaNode.type;
    const ok =
      (t === 'string' && typeof instance === 'string') ||
      (t === 'integer' && Number.isInteger(instance)) ||
      (t === 'number' && typeof instance === 'number') ||
      (t === 'boolean' && typeof instance === 'boolean') ||
      (t === 'object' && typeof instance === 'object' && !Array.isArray(instance)) ||
      (t === 'array' && Array.isArray(instance)) ||
      (t === 'null' && instance === null);
    if (!ok) {
      errors.push(`${path}: expected type ${t}, got ${typeof instance}`);
      return;
    }
  }
  if (schemaNode.const !== undefined && instance !== schemaNode.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schemaNode.const)}, got ${JSON.stringify(instance)}`);
  }
  if (Array.isArray(schemaNode.enum) && !schemaNode.enum.includes(instance)) {
    errors.push(`${path}: value ${JSON.stringify(instance)} not in enum ${JSON.stringify(schemaNode.enum)}`);
  }
  if (typeof instance === 'string') {
    if (typeof schemaNode.minLength === 'number' && instance.length < schemaNode.minLength) {
      errors.push(`${path}: string shorter than minLength ${schemaNode.minLength}`);
    }
    if (typeof schemaNode.maxLength === 'number' && instance.length > schemaNode.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schemaNode.maxLength}`);
    }
    if (typeof schemaNode.pattern === 'string') {
      try {
        const re = new RegExp(schemaNode.pattern);
        if (!re.test(instance)) errors.push(`${path}: string does not match pattern`);
      } catch (err) {
        errors.push(`${path}: schema pattern invalid (${err.message})`);
      }
    }
  }
  if (schemaNode.required && typeof schemaNode.required === 'object' && Array.isArray(schemaNode.required)) {
    if (typeof instance === 'object' && !Array.isArray(instance)) {
      for (const key of schemaNode.required) {
        if (!(key in instance)) errors.push(`${path}.${key}: required field missing`);
      }
    }
  }
  if (schemaNode.additionalProperties === false && typeof instance === 'object' && !Array.isArray(instance)) {
    const allowed = new Set(Object.keys(schemaNode.properties ?? {}));
    for (const key of Object.keys(instance)) {
      if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed by schema`);
    }
  }
  if (schemaNode.properties && typeof instance === 'object' && !Array.isArray(instance)) {
    for (const [key, sub] of Object.entries(schemaNode.properties)) {
      walk(sub, instance[key], `${path}.${key}`);
    }
  }
  if (schemaNode.items && Array.isArray(instance)) {
    instance.forEach((item, idx) => walk(schemaNode.items, item, `${path}[${idx}]`));
  }
}

function main() {
  const args = parseArgs();
  let result, schema;
  try { result = JSON.parse(readFileSync(args.result, 'utf8')); }
  catch (err) {
    stderr.write(`error: could not read result ${args.result}: ${err.message}\n`);
    exit(2);
  }
  try { schema = JSON.parse(readFileSync(args.schema, 'utf8')); }
  catch (err) {
    stderr.write(`error: could not read schema ${args.schema}: ${err.message}\n`);
    exit(2);
  }
  walk(schema, result, '$');
  if (errors.length > 0) {
    stderr.write(`schema check failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
    exit(1);
  }
  stdout.write(`schema check passed for ${args.result}\n`);
}

main();