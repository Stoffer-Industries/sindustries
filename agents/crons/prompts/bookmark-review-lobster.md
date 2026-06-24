## Pre-check — bail early if nothing to do

Run this first:

```
python3 -c "
import json, subprocess, sys

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd='/Users/quinnstoffer/.openclaw/workspace')
    try:
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except Exception:
        return {}

curate = run(['python3', 'codebases/sindustries/agents/workflows/bookmarks/scripts/list_curate_candidates.py', '--json']).get('count', -1)
specs  = run(['python3', 'codebases/sindustries/agents/workflows/bookmarks/scripts/list_spec_requests.py', '--json']).get('count', -1)

with open('/Users/quinnstoffer/.openclaw/workspace/brain/state/bookmark-review-state.json') as f:
    state = json.load(f)
lobster_ready = sum(
    1 for v in state.get('items', {}).values()
    if v.get('reviewStatus') == 'spec_created'
    and v.get('approvalStatus') not in ('pending', 'approved', 'declined')
)

print(json.dumps({'curate': curate, 'specs': specs, 'lobster_ready': lobster_ready}))
"
```

If all three values are 0, stop here and reply exactly: NO_REPLY

Otherwise continue below.

---

Before the Lobster run, do the production bookmark review work in this order.

1. Bookmark curation

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/bookmarks/curate/SKILL.md`

Run the candidate list command:
`python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/scripts/list_curate_candidates.py --json`

If `count == 0`, skip scoring and still run the validate command below.

If candidates exist, score the batch exactly as the skill describes:
- Score each candidate 0-10 against every topic in the config.
- Choose the highest scoring topic as the primary topic.
- Write decisions to `brain/state/curate-output.json`.
- Do not mutate state directly.

Then validate/apply curation state:
`python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/scripts/validate_curate_output.py --json`

2. Spec writing and validation

Read and follow:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/product/spec-author/SKILL.md`

Run the spec request list command:
`python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/scripts/list_spec_requests.py --json`

If `count == 0`, skip writing and still run the validate command below.

If spec requests exist:
- Process at most 2 requests in this cron run.
- Read each requested bookmark file and review file.
- Read `/Users/quinnstoffer/.openclaw/workspace/docs/state-of-the-nation.md`.
- Read all existing specs under `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/docs/specs/`.
- For `requestType == "new"`, write the spec markdown to `brain/bookmarks/specs/<slug>-<bookmarkKey>.md`.
- For `requestType == "revision"`, read the existing specs named by `existingSpecDocs`, apply the requested revision, and overwrite the same spec path.
- Append entries to `brain/state/spec-output.json`; merge with existing entries if the file already exists.
- Do not call `update_spec_state.py`.
- Do not trigger approval delivery from this phase.

Then validate/apply spec state exactly once:
`python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/scripts/validate_spec_output.py --json`

After curation and spec validation, run this exact command with the exec tool and base your reply only on its JSON output:
python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/bookmarks/run.py

Do not summarize from memory. Base your reply only on the JSON output.

Status field meanings:
- `needs_approval` — new approval delivered this run; say that approval was sent.
- `no_approval_needed` — pipeline ran, nothing ready for approval yet; this is success.
- `waiting_on_approval` — an approval is already pending Tom's reply; dedup prevented re-send. This is a healthy state. Do NOT escalate.
- `partial_failure` — approval items exist but are missing resumeTokens; this IS a soft fail, escalate.
- any non-zero exit or `ok: false` — escalate.

If the command fails (non-zero exit or `ok: false`) or status is `partial_failure`, report the failure exactly.

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md and follow it.
If the output of this cron has soft failures or unacceptable errors, escalate that to Lox's main session.

If the script succeeds, say exactly: NO_REPLY
