# Secret scan triage runbook

This runbook is the operational record for repository-wide gitleaks triage.
The detection policy lives in `.gitleaks.toml`; the shared execution policy
lives in `infra/cloud/scripts/run-secret-scan.sh`. This document records the
procedure and the per-finding remediation state. It never records a credential
value, matched text, an entropy score, or a value-derived hash.

## Source of truth

- **Rules and allowlist:** `.gitleaks.toml`
- **Scan scopes and failure contract:** `infra/cloud/scripts/run-secret-scan.sh`
- **Pinned installer:** `infra/cloud/scripts/install-gitleaks.sh`
- **Merge-gate job:** `.github/workflows/ci.yml` (`gitleaks`)
- **Scheduled history alert:** `.github/workflows/secret-scan-history.yml`
- **Durable system posture:** `docs/systems/cloud-platform.md`

The merge gate scans both the pull-request change and the tracked tree. The
scheduled workflow scans the published history and the tracked tree. Every
surface calls the same entrypoint so the detection policy cannot drift.

## Run a triage scan locally

Install the pinned CLI (the version and SHA256 are resolved by the installer):

```bash
bash infra/cloud/scripts/install-gitleaks.sh
export PATH="$HOME/.local/bin:$PATH"
```

Scan the published history and write a metadata-only report:

```bash
bash infra/cloud/scripts/run-secret-scan.sh --history \
  --report /tmp/sindustries-secret-history.json
```

Scan the tracked tree and write a metadata-only report:

```bash
bash infra/cloud/scripts/run-secret-scan.sh --tree \
  --report /tmp/sindustries-secret-tree.json
```

The command output names the resolved scope and the finding count. A missing
binary, missing config, empty commit scope, or empty tracked-tree scope is a
failure; it is never treated as a clean result.

## Triage one finding

1. Record only the rule ID, path, line, commit and scope. Do not copy the
   matched value into this document, a task comment, an issue, a pull request,
   or chat.
2. Classify the finding as a genuine credential, an elided/non-usable value,
   or a false positive.
3. For a genuine credential, revoke or rotate it out of band first. Record the
   owner and completion state in the ledger; never record the value.
4. Remove the credential from the current tree in the same change that proves
   the removal. History treatment is a separate, explicit decision.
5. For a false positive, prefer changing the content. If an allowlist entry is
   unavoidable, scope it to the exact file or expression, add an inline reason,
   and add the finding to the ledger.
6. Re-run the history and tree scopes. Both must report their scope and a
   finding count of zero before the finding is closed.

## History rewrite gate

Do not rewrite published history as part of routine triage. A rewrite requires
all three conditions:

1. Tom or Quinn explicitly approves that exact rewrite.
2. The credential is confirmed live, so the rewrite buys real remediation.
3. A backup ref and a written rollback procedure exist before any force-push.

The default path is **rotate, remove from the tree, and document the residual**.
The weekly history scan is an alerting surface; it does not block a merge that
does not contain the finding.

## Findings ledger

The 2026-11-10 triage measured the full published history and the tracked tree
at main commit `0be5af0b` with gitleaks `8.30.1`, using the enforced config
and redacted output. The initial main-and-remote-ref measurement resolved
3,450 commits and surfaced two non-synthetic findings. A later local `--all`
scope, which also included cached pull-request head refs, resolved 4,015
reachable commits; gitleaks scanned 3,900 patch-bearing commits and surfaced
six findings: three non-synthetic published-history findings and three
synthetic canary commits from prior negative-control pull requests. The
scheduled workflow deliberately excludes pull-request head refs and scans
published branches and tags only, so the synthetic canary commits are a local
residual rather than part of the scheduled alert scope. The tracked-tree scope
resolved 1,360 files at main (1,361 on the implementation branch, which adds
the approved tech design). Every finding was reviewed individually.

The enforced baseline uses rule-scoped allowlists only. Each allowlist matches
one rule, one exact commit and one exact path; there is no repository-wide,
directory-wide or file-wide path suppression. The resulting baseline scans
clean, and the rows below preserve the residual history surface explicitly.

| Scope | Rule | Path | Commit | Line | Triage | Remediation status | Owner | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| History | `generic-api-key` | `apps/gymtrack/api/oauth/token.js` | `5e6fc702547e343f09587d634ba1757923136aae` | 56 | False positive: the matched span is a destructured `hashToken` identifier, with no assignment or quoted value; the file is absent from main. | No credential was exposed. No rotation or rewrite is required. The exact rule, commit and path are allowlisted together. | Rowan | 2026-11-10 |
| History | `generic-api-key` | `docs/repo-audits/2026-W26.md` | `6a59bec3a472e89303fa28f34d38eeee6018fb1b` | 135 | Elided/non-usable value: the published line contains only a prefix followed by an ellipsis, never the complete credential; the current main line is redacted. | No complete credential was committed. The underlying local key's rotation confirmation remains an operator action owned by Tom; the published residual is documented and narrowly allowlisted rather than hidden by a broad suppression. | Tom | 2026-11-10 |
| History | `generic-api-key` | `docs/repo-audits/2026-W26.md` | `6819c8fef2567790c6759101d0c4e093af10e22b` | 135 | Alternate published history for the same elided/non-usable W26 value; triaged independently from the preceding commit. | No complete credential was committed. Rotation confirmation remains owned by Tom; the exact rule, commit and path are allowlisted together. | Tom | 2026-11-10 |
| History | `sindustries-secret-scan-canary` | `infra/cloud/secret-scan-canary.txt` | `4cc7c358795f6d3230b91b668a657146acbadf54` | 1 | Synthetic marker published by the prior negative-control pull request; it is not a credential. | No credential was exposed. The exact rule, commit and path are allowlisted together; a new canary commit must still fail the tree scan. | Rowan | 2026-11-10 |
| History | `sindustries-secret-scan-canary` | `infra/cloud/secret-scan-canary.txt` | `8485bb99d6dd7340bec81fb5d17e3e675dd59002` | 1 | Synthetic marker published by the prior negative-control pull request; it is not a credential. | No credential was exposed. The exact rule, commit and path are allowlisted together; a new canary commit must still fail the tree scan. | Rowan | 2026-11-10 |
| History | `sindustries-secret-scan-canary` | `infra/cloud/secret-scan-canary.txt` | `7c9615a621eafa8bee07bd4819bb4136d7eb91e7` | 1 | Synthetic marker published by the prior negative-control pull request; it is not a credential. | No credential was exposed. The exact rule, commit and path are allowlisted together; a new canary commit must still fail the tree scan. | Rowan | 2026-11-10 |

A future scan finding is added as a new row before it is closed. Removing a
row requires the remediation status to say why the residual no longer exists.
