# Tom's worldview profile — angle selection

This is the stable, version-controlled profile the structured angle model
scores against. The CTO Craft pipeline uses it via the parent
`angle-evaluator.md` system prompt; we keep it in a separate file so
clarity-vs-rule tweaks don't have to touch the schema contract.

## Builder/architect lens

Tom frames engineering and product work as building things other people
can and do operate. He is suspicious of systems that centralise expertise
in a single person or team but also sceptical of "everyone owns it"
diffusion that produces no clear contracts. Articles that hit at least
one of:

- real boundary decisions (who owns what, what crosses the line,
  what fails silently);
- information architecture at the team or system level (where context
  lives, how it gets refreshed, who is the source of truth);
- the cost of organisational complexity transposed as build cost;

get a resonance bump. Articles that read as pure process coaching or
generic "communicate better" advice are penalised.

## Anti-rent-hours bias

Tom is allergic to organisations that pay for hours of activity rather
than productive change. An article resonates when it:

- names a specific failure mode of "we paid for the time, you owe us the
  output";
- frames a process choice in terms of who is exposed to the cost of
  slow iteration;
- gives a concrete heuristic for distinguishing productive work from
  maintenance theatre.

Articles that read as "eight hours a week is fine if you track it" or
"standups are great" lose points.

## Autonomy and ownership

Tom favours ownership models where accountability is local and the
people closest to the work control the decision. He is sceptical of
"shared" models that throw problems to a committee and is equally
sceptical of "hero" models that sink one person.

A strong angle names the specific autonomy tension: who has the
information, who makes the call, and what is the failure path when
those two roles disagree. Articles that only moralise about "empowerment"
are weak signals.

## Anti-fluff

Tom is allergic to phrasing that sounds executive and carries no
information. Word markers that subtract points:

- "leverage", "synergy", "value-add", "circle back", "move the needle",
  "best of breed", "thought leader", "low-hanging fruit", "10x";
- stock openings ("In today's fast-paced world…", "Every great leader…");
- hedging endings ("only time will tell", "the future is bright").

A tweet body whose first eight words include any of those tokens is
automatically disqualified. The model must rewrite the angle using the
actual claim.

## Hard-money mindset

Tom assumes the unit economics of a decision should be visible. An
article resonates when it:

- names the cost of delay, the cost of error, or the cost of iteration;
- gives a threshold rule of thumb ("if X takes more than Y hours,
  it's cheaper to do Z");
- frames abstractions in terms of where the spend goes.

Articles that never touch the dollar or the hour are weak signals for
this source.

## Selection heuristic

The model scores resonance on a 0.0–1.0 scale using the profile above:

- 0.85–1.00: at least two axes name a concrete failure mode the article
  documents, plus a tweet body that survives the anti-fluff check.
- 0.70–0.84: one strong axis hit, tweet body clean.
- 0.55–0.69: tangentially relevant, requires another axis to clear
  the bar.
- 0.54 and below: discard.

The selection threshold is configurable via
`CTO_CRAFT_MIN_RESONANCE_SCORE` (default 0.55). Lowering it widens the
acceptance band; raising it sharpens the bar.
