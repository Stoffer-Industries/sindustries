---
name: tweet-short-tip
description: "Write a short-form tip tweet: a concrete, specific technique, tool, or system Sindustries actually uses. Demonstrates expertise through a real mechanism, not an opinion or a story."
---

# Tweet: Short-Form Tip

One of three tweet types in the weekly short-tweet mix (alongside `tweet-personal-philosophy` and `tweet-personality-post`). This one's job: demonstrate expertise by naming a real, specific mechanism — a tool, a step, a number — that Sindustries actually built or used. Readers should finish it knowing one concrete thing they didn't know before.

## When to use

- The source material (a cto-craft angle, a shipped feature, a retro note, a weekly review item) contains a real technique, architecture decision, or measurable result.
- Use `tweet-personal-philosophy` instead when the material is an opinion/belief with no mechanism attached.
- Use `tweet-personality-post` instead when the material is a personal story about Tom, not a system.

## Inputs

- `source_material` — the angle, evidence excerpt, or notes this tip is drawn from. Required.
- `canonical_url` — link to the source article/PR/doc, if the claim depends on it. Optional (see Link policy below).
- `worldview_axes` — which of Sindustries' worldview axes this reinforces: `builder_architect`, `anti_rent_hours`, `autonomy_ownership`, `anti_fluff`, `hard_money`. Helps pick emphasis, not required to name in the tweet.

## Structure

1. **Hook — specific result or claim, one line.** Not a vague achievement. Name the thing: the metric, the system, the failure mode avoided. ("Specific beats clever" — Ivy's SOUL.md.)
2. **The mechanism — 1-3 short lines or a numbered micro-list.** The actual how. Enough for a reader to recognize the pattern in their own work, not enough to be a full how-to.
3. **Close — one line that lands the point.** No CTA theater, no "thoughts?" Land the idea and stop.

Keep sentences short. Vary length — a mountain/reverse-mountain rhythm (short, longer, short) reads better than uniform length. No hashtags. No markdown.

## Link policy

Include the source URL only when it's load-bearing — a specific data point, named tool, or framework the reader would want to verify or dig into. If the tip stands on its own (a pattern, a lesson, a number you're stating plainly), skip the link. When included, it's the final token in the tweet; budget 23 characters for it against the 280 limit.

## Voice rules (non-negotiable — see `no-ai-slop` for full list)

- Proof beats promise. Don't claim a system is good — show what it does.
- No fake certainty, no startup theater, no hype words (banned list: leverage, streamline, robust, cutting-edge, game changer, supercharge, etc.)
- Active voice. Things don't "get automated" — we automate them.
- Never invent a number, a result, or a detail not in the source material. If the source material doesn't have a concrete number, don't write one — use a qualitative mechanism instead ("replaced three manual approval steps with one gate," not "cut time by 73%" if no one measured it).
- No first-person Tom voice without explicit approval (per Ivy's SOUL.md Content Voice rules) — write as Sindustries/the team unless approval is already on record for this item.

## Example shape (illustrative structure only — do not reuse verbatim, and never invent the specifics)

```
[Specific thing that happened] — here's the mechanism:

1. [Step/component]
2. [Step/component]
3. [Step/component]

[One-line payoff, stated plainly, no hype.]
```

## Output

Return the tweet body (≤280 raw characters, no markdown, no hashtags) plus one line stating which source material it came from and whether the link was included and why.
