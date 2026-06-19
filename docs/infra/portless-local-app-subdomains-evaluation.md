# Portless Local App Subdomains Evaluation

**Task:** `474e5525-8362-4e75-9b40-6d5dd18c5bb5`  
**Spec:** `brain/specs/infra/portless-local-app-subdomains.md`  
**Date:** 2026-06-19  
**Evaluator:** Rowan  
**Portless version tested:** `0.14.0` via `npm exec --yes portless@0.14.0`  
**Verdict:** defer full adoption

## Summary

Portless is promising for Tom's local multi-worktree setup, but it is not ready
for full-stack adoption as the default workflow yet. The core local routing
behavior works, including worktree-aware hostnames, but the default macOS
HTTPS/trust path is not safe for unattended agent, cron, or CI execution.

Do not install Portless globally or migrate the local stack until Tom or Quinn
chooses one of these paths:

1. accept this defer verdict and keep the port-based workflow;
2. run a human-supervised one-time `portless trust` / HTTPS setup spike in a
   real terminal, then re-evaluate;
3. intentionally adopt high-port HTTP mode and revise the spec because that
   gives up the clean `https://*.localhost` outcome.

## Evidence

### Functional routing works on a high HTTP proxy port

Command shape:

```bash
PORTLESS_STATE_DIR="$(mktemp -d /tmp/portless-eval.XXXXXX)" \
PORTLESS_SYNC_HOSTS=0 \
PORTLESS_HTTPS=0 \
PORTLESS_PORT=18443 \
npm exec --yes portless@0.14.0 -- demo node -e '...'
```

Observed result:

```text
Active routes:

  http://demo.localhost:18443  ->  localhost:4440  (pid 32527)
```

The route returned the child app response through the Portless proxy:

```json
{"url":"http://demo.localhost:18443","port":"4440","host":"127.0.0.1"}
```

This proves the basic routing layer works without privileged ports, TLS trust,
or `/etc/hosts` writes when `PORTLESS_SYNC_HOSTS=0` is set.

### Worktree-aware routing works in run mode

I created a temporary git repository with a linked `rowan` worktree and a
minimal `package.json` dev script, then started both worktrees through the same
non-privileged Portless proxy.

Observed routes:

```text
Active routes:

  http://portless-wt-eval.localhost:18444        ->  localhost:4844  (pid 32690)
  http://rowan.portless-wt-eval.localhost:18444  ->  localhost:4592  (pid 32678)
```

The linked worktree log included:

```text
-- rowan.portless-wt-eval.localhost (auto-resolves to 127.0.0.1)
-- Name "portless-wt-eval" (from package.json)
-- Prefix "rowan" (from git branch)
```

This confirms Portless can solve the multi-agent worktree hostname problem when
apps are launched through Portless run mode. Earlier task comments also note a
more specific `apps/tasks` Vite smoke test where `portless run --name
tasks-eval` generated a branch-prefixed hostname and returned HTTP 200 with
`X-Portless: 1`.

### Default HTTPS/trust path is the blocker

Even asking for help on the trust command was unsafe in this environment:

```bash
npm exec --yes portless@0.14.0 -- trust --help
```

Portless did not print help. It generated local CA files under
`~/.portless/`, then blocked inside macOS Keychain trust insertion:

```text
Generated local CA certificate.
security add-trusted-cert -r trustRoot -k /Users/quinnstoffer/Library/Keychains/login.keychain-db /Users/quinnstoffer/.portless/ca.pem
```

I killed the stuck `npm`, `node`, and `security` processes. No active Portless
routes remained afterward.

Earlier task evidence recorded the same blocker on default HTTPS startup:
non-interactive sudo could not read a password for port 443, Portless fell back
to another port, then blocked at `security add-trusted-cert` instead of failing
fast. That violates the headless/CI posture required by the spec.

## Acceptance Criteria Status

- [x] **AC1 - Evaluation verdict written:** complete. Verdict is defer full
  adoption, grounded in smoke tests and the concrete macOS trust blocker.
- [ ] **AC2 - Stable memorable URLs:** not pursued because AC1 is not adopt.
- [ ] **AC3 - Worktree-aware routing:** proven feasible in evaluation, not
  rolled out because AC1 is not adopt.
- [ ] **AC4 - Lox daily review stays clean / config declarative:** not pursued
  because AC1 is not adopt.
- [ ] **AC5 - Tested rollback path:** partial cleanup only. The full install
  path was not completed, so there is no adopted workflow to roll back.
- [ ] **AC6 - Headless / CI fail-fast:** failed. The default trust path blocked
  instead of failing cleanly.
- [ ] **AC7 - Consolidated source of truth / duplicate task cleanup:** not
  performed here because the task instructions said not to change task state and
  the defer verdict needs Quinn/Tom follow-up.

## Cleanup Performed

- Stopped the test Portless proxies with `portless proxy stop`.
- Killed the stuck trust probe processes.
- Confirmed `portless list` reported no active routes after cleanup.
- Moved the generated `~/.portless` state from the interrupted trust probe to
  `~/.Trash/portless-eval-state-20260619145247`.

Because trust insertion did not complete, I did not run a global cleanup against
Keychain or `/etc/hosts`. A later rollback spike should explicitly run and
document `portless clean`, `portless hosts clean`, and keychain trust removal
after a completed install.

## Recommendation

Keep the current port-based local workflow for now. Re-open adoption only if
Tom explicitly accepts a one-time interactive trust setup, or if Portless gains
a documented non-interactive fail-fast path suitable for agents and cron.
