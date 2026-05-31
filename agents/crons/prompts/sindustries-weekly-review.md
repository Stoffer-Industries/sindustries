Friday weekly SIndustries review. Run in the workspace root: /Users/quinnstoffer/.openclaw/workspace

## Step 1 — get the weekly prompt

Run:
```
python3 scripts/weekly-review/prompt_tom.py --json
```

Capture the `prompt` and `week` values from the JSON output.

## Step 2 — ask Tom for his notes

Send Tom the prompt via Telegram:
```
openclaw message send --channel telegram --account default --target 6435140143 --message "<prompt text>\n\nReply here with your notes and I'll create the review file and open a PR."
```

Then poll `sessions_history` for the lox or quinn infra session every 5 minutes for up to 90 minutes, looking for a new message from Tom (sender_id 6435140143) that is a reply in response to the weekly review prompt.

If no reply arrives within 90 minutes, skip to notify-soft-fails and report: "Weekly review: no response from Tom after 90 minutes — skipping this week."

## Step 3 — create the review file

Once Tom's reply is captured, pipe his notes to:
```
echo '{"approvalResponse": "<tom_notes>", "week": "<week>"}' | python3 scripts/weekly-review/create_review_file.py --reviews-root brain/reviews/website-content --json
```

Capture the JSON output (contains `review_path`, `review_date`, `raw_notes`).

## Step 4 — distil daily notes

Pipe the previous output to:
```
python3 scripts/weekly-review/distil_daily_notes.py --json
```

The script extracts any accumulated daily notes from the review file. The output JSON contains a `daily_notes` list and `review_path`.

If there are daily notes, use your judgment to triage each one into either the "Needs approval from Tom" or "Needs approval from Quinn" section of the review file at `review_path`. Follow the section descriptions already in the file.

Update the `daily_notes_count` field in the JSON before passing to step 5.

## Step 5 — open the PR

Pipe the output to:
```
python3 scripts/weekly-review/open_review_pr.py --json
```

Capture the `pr_url` from the output.

## Step 6 — notify Tom

Send Tom a confirmation:
```
openclaw message send --channel telegram --account default --target 6435140143 --message "Weekly review ready: <pr_url>"
```

# notify-soft-fails
Read /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/notify-soft-fails/SKILL.md and follow it.
If any step fails (script exits non-zero, Tom doesn't reply, PR open fails), escalate to Lox's main session with a summary of what failed.
