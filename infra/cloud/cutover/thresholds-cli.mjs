#!/usr/bin/env node
/**
 * infra/cloud/cutover/thresholds-cli.mjs
 *
 * The command-line entry point of the abort-threshold evaluator.
 *
 * WHY THIS FILE EXISTS
 *
 *   `thresholds.mjs` is a MODULE: it exports the threshold semantics and
 *   also knows how to run them from the command line. Whether the CLI
 *   block runs is decided by "is this module the process entry point",
 *   and that decision was made by comparing a raw path against a module
 *   URL. The two disagree whenever the path is not byte-identical to the
 *   URL — a symlinked checkout, a temporary directory, a path with a
 *   space in it.
 *
 *   When they disagreed, the CLI block did not run, the module exited 0
 *   WITHOUT evaluating anything, and the executor read exit 0 as "no
 *   threshold breached". The abort thresholds were silently disabled.
 *
 *   That comparison cannot be relied on for a GATE. So the production
 *   call path does not use it at all: this wrapper imports the module
 *   and calls `runCli()` unconditionally. There is no entry-point
 *   detection here, so there is nothing to get wrong — the evaluator
 *   either evaluates the window or this process throws.
 *
 *   `thresholds.mjs` keeps its own CLI for direct, interactive use, and
 *   that path now compares REAL paths.
 *
 * EXIT CODES (the whole contract — the executor branches on them):
 *
 *   0  the window breaches nothing
 *   1  the window breaches at least one threshold
 *   2  the window could NOT be evaluated
 *
 * Code 2 is NOT a pass. An evaluator that cannot read its manifest or
 * its samples must never be read as "no breach".
 */
import { runCli } from './thresholds.mjs';

try {
  process.exitCode = runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
