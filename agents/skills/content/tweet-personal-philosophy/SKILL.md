---
name: tweet-personal-philosophy
description: "Write a hard-hitting personal philosophy tweet: a standalone opinion or belief statement that filters the audience toward people who share Sindustries' worldview. No story, no mechanism — just a stated belief."
---

# Tweet: Hard-Hitting Personal Philosophy

One of three tweet types in the weekly short-tweet mix (alongside `tweet-short-tip` and `tweet-personality-post`). This one's job isn't to teach or to tell a story — it's to state a belief plainly enough that it filters the audience. People who agree lean in; people who don't, scroll past. That's the point: higher-signal followers, not maximum reach.

## When to use

- The source material (a cto-craft angle, an article reaction, a retro note, something Tom said in a working session) contains a genuine opinion or a disagreement with a common take — something that reflects one of Sindustries' worldview axes: `builder_architect`, `anti_rent_hours`, `autonomy_ownership`, `anti_fluff`, `hard_money`.
- Use `tweet-short-tip` instead when there's a concrete mechanism to show, not just a belief.
- Use `tweet-personality-post` instead when the material is a personal story, not a standalone claim.

## Structure

1. **The claim — one or two short lines. No hedging.** State the belief as fact, not as "I think" or "in my opinion." Confidence is the format; hedge words undercut it.
2. **Optional second beat — the contrast or the "why," one line.** What it's not, or what it costs to ignore it. Only if it sharpens the point — don't pad.
3. **No CTA, no question, no "thoughts?"** The tweet is complete as a statement. Let replies happen organically.

Short, symmetrical sentences read better here than anywhere else in the rotation — this format lives or dies on rhythm. Cut every filler word.

## Disagreement copy (when the angle pushes back on a common take)

If the philosophy disagrees with or pushes back on something (an article's take, a popular practice, conventional wisdom), the tweet must state the actual reason for disagreeing — a counterexample, a missing constraint, a named failure mode — not just an opinion dropped next to a link. The reasoning is the argument. A link, if included, corroborates it; it never substitutes for it.

## Link policy

Almost never include a link. This format is explicitly standalone — a link undercuts the "stated belief" format by turning it into a referenced claim instead of a conviction. Only include one when the disagreement specifically targets a named source and the reader needs to see what's being disagreed with to judge the claim fairly.

## Voice rules (non-negotiable — see `no-ai-slop` for full list)

- State it as fact. No "I think," "in my opinion," "personally" — the confidence is the hook.
- No fake certainty about things that are genuinely uncertain — this is about stated values and worldview, not invented facts or predictions dressed as truth.
- No hype language (banned list: leverage, streamline, paradigm shift, game changer, transformative, etc.) — those words are the opposite of this format's job.
- Must reflect a worldview axis Sindustries actually holds (see axes above) — never invent a hot take just to be edgy. Check it against `agents/ivy/SOUL.md` Content Voice section and USER.md if unsure whether it's actually Tom's view.
- No first-person Tom voice without explicit approval (per Ivy's SOUL.md Content Voice rules) — write as a Sindustries/team belief unless approval is already on record for this item.
- Never claim this is controversial for shock value alone — "novel" beats "extreme." The doc that inspired this skill type got this part right: the hook doesn't need to be extreme, it needs to be true and under-said.

## Example shape (illustrative structure only — do not reuse verbatim, and never invent the specifics)

```
[Stated belief, no hedge].

[Optional: what it's not, or the cost of ignoring it].
```

## Output

Return the tweet body (≤280 raw characters, no markdown, no hashtags) plus one line naming which worldview axis it reflects and which source material it came from.
