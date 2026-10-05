// Type shim for the CJS preload entry point.
// The actual implementation lives in ./register.cjs and is intended to be
// loaded via `tsx --require @sindustries/otel-node/register` or Node's
// `--require` flag before any application code is parsed. The shim is
// `void`-typed so importing it from TypeScript is safe — it has no
// runtime exports, only side effects.
declare module '@sindustries/otel-node/register';
