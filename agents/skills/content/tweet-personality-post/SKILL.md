---
name: tweet-personality-post
description: "Write a short personality tweet: a brief personal story, arc, or admission that helps readers connect with Tom/Sindustries on a human level, not just as a systems-building account."
---

# Tweet: Short Personality Post

One of three tweet types in the weekly short-tweet mix (alongside `tweet-short-tip` and `tweet-personal-philosophy`). This one's job is connection, not instruction or belief-stating. A small, true story or admission — something a reader remembers about the person behind the systems, not another system.

## When to use

- There's a real personal detail, mistake, turning point, or struggle on record — in `USER.md`, `MEMORY.md`, a retro note, or something Tom has explicitly said can be shared publicly.
- Use `tweet-short-tip` instead when the material is really about a mechanism/system, not a personal arc.
- Use `tweet-personal-philosophy` instead when there's no story, just a stated belief.

**Hard gate:** this format is the highest-risk of the three for approval purposes. Any first-person Tom voice, any reference to specific numbers (payouts, revenue, team size, personal history details) needs explicit Tom approval before it ships — per Ivy's SOUL.md Content Voice rules ("No first-person Tom copy without explicit approval"). When in doubt, flag it as a review question rather than guessing.

## Structure

1. **Hook — signal a story is coming, one line.** A role, a moment, an age, a before-state. Something that promises a real arc, not a lesson dressed as a story.
2. **The arc — 2-4 short lines, ideally with a visible turn.** What was believed/tried/broke → what was learned. Use a simple before/after shape (arrows or line breaks work well), not a wall of prose.
3. **The turn — one line stating what changed and why it matters now.** This is the payoff; land it plainly, no hype.

This is the one format where rawness and specificity matter more than tidiness. Keep the self-aware, slightly imperfect voice — don't let an editing pass sand it down to generic positivity (see `no-ai-slop`: "preserve the writer's real voice," "don't make every paragraph equally tidy").

## Link policy

Never include a link. This format is explicitly about the person, not a referenced claim — a link breaks the intimacy of the format and reads as an ad.

## Voice rules (non-negotiable — see `no-ai-slop` for full list)

- Must be grounded in a real, on-record detail — never invent a struggle, a number, or a timeline that didn't happen. If the source material is vague, ask for the real specifics rather than filling the gap with something plausible-sounding.
- No fake vulnerability as a growth tactic — the story has to be true and have a real "then I learned X," not a manufactured redemption arc bolted onto a generic lesson.
- No startup theater, no hype words, no "the real truth is..." framing.
- Specific beats clever: a real age, a real role, a real break — not a vague "early in my career."
- Flag for Tom approval before shipping: any first-person Tom voice, any specific personal/financial/career detail, anything that reveals more than what's already public.

## Example shape (illustrative structure only — do not reuse verbatim, and never invent the specifics)

```
[Role/moment that signals a story]. (1)

At [real point in time]:
→ [what was believed/tried]
→ [what broke or didn't work]

Then [what was actually learned].

[One-line statement of what changed and why it matters now].
```

## Output

Return the tweet body (≤280 raw characters, no markdown, no hashtags) plus:
- which on-record detail it's grounded in (file + line, or note),
- an explicit flag: "needs Tom approval: yes/no" and why.
