---
name: website-content
description: "Produce and update SIndustries website content for experiments, systems, releases, stories, and stacks from grounded source material."
---

# Website Content Skill

Turn grounded source material into SIndustries website copy. Preserve Tom's operator voice without impersonating him, and flag anything that needs his personal approval.

## Inputs

- **raw notes** — source material (task description, weekly review notes, spec excerpt, release notes)
- **target type** — `experiment | system | release | story | stack`
- **intended audience** — general public, builders, investors, collaborators
- **evidence links** — task URL, PR, spec, screenshot, or public URL that proves the work is real
- **desired tone** — default is "operator voice: specific, proof-over-promise, no hype"
- **approval risk level** — `low | medium | high`

## Copy Produced

For each content item, produce ALL of:

1. **Card copy** — 1-2 sentences, for homepage/listing cards. Specific and proof-based.
2. **Long-form draft** — full description for the detail page. Include context, what changed, why it matters.
3. **Meta description** — <160 chars for SEO and social sharing
4. **Title and dek** — title ≤ 60 chars, dek ≤ 120 chars
5. **Claim-risk notes** — list any claims that require Tom's personal approval
6. **Review questions for Tom** — specific things to confirm before publishing (e.g., "is this status accurate?", "should we mention the milestone?")

## Content Type Templates

### Experiment
```
title: ""
slug: "slug-format"
status: "idea | active | paused | shipped | killed"
summary: 1-2 sentences
why: Why this bet was made
successCriteria: What done looks like
currentLearning: ["oldest first, append new as they happen"]
startedAt: ISO date
updatedAt: ISO date
links: [{title, url}]
image: /brand/studio/[slug]-hero.png
visibility: "draft | review | published | archived"
```

### System
```
title: ""
slug: "slug-format"
status: "designing | building | operating | retired"
summary: 1-2 sentences
problem: What it solves
howItWorks: How it works
proof: Evidence it's real (task, PR, or link)
updatedAt: ISO date
links: [{title, url}]
image: /brand/systems/[slug]-hero.png
visibility: "draft | review | published | archived"
```

### Release
```
title: ""
slug: "slug-format"
releasedAt: ISO date
summary: 1-2 sentences
type: "product | system | content | experiment | infrastructure"
links: [{title, url}]
evidence: URL or task reference
visibility: "draft | review | published | archived"
```

### Story
```
title: ""
slug: "slug-format"
dek: Short paragraph hook
body: Full story text (Markdown)
source: "original | x-thread | bookmark-review | project-retro | release-note"
topics: ["tag1", "tag2"]
draftedAt: ISO date
publishedAt: ISO date or null
visibility: "draft | review | published | archived"
canonicalUrl: https://x.com/... or null
```

### Stack
```
name: ""
category: "agent | model | infra | app | workflow | design"
summary: 1-2 sentences
whyWeUseIt: Why this tool
status: "core | testing | retired"
links: [{title, url}]
updatedAt: ISO date
visibility: "draft | review | published | archived"
```

## Copy Principles

- Specific beats clever
- Proof beats promise
- Systems language is fine — explain human value
- No fake certainty ("revolutionary", "game-changing", "best-in-class")
- No pretending Quinn is Tom
- No first-person Tom copy without explicit Tom approval
- No startup theater or buzzwords

## Claim Risk Levels

**Low** — Quinn can approve and merge:
- Metadata updates (dates, links, status changes)
- Factual content about already-shipped items
- Stack list additions
- Typo fixes

**Medium** — Quinn approves, then Tom sees in weekly review:
- New experiments or systems being announced
- Status changes that imply strategic direction

**High** — Tom must approve before any PR merges:
- First-person Tom voice copy
- Revenue, pricing, customer, or investment claims
- Public strategic commitments
- Anything about Tom's employer or family
- Claims that could look like a public promise

## Workflow

1. Read raw notes and identify what content type applies
2. Check evidence links — content must have proof before publishing
3. Apply template to produce all copy fields
4. Flag claim-risk level
5. Write review questions for Tom
6. For **low-risk** items: produce Quinn-approval PR directly
7. For **medium/high-risk** items: route into a Tom-approval PR or ask for Tom input before authoring when the source material is insufficient
