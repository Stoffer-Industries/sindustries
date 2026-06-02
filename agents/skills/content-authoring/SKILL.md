# content-authoring skill

## Purpose

Produce publication-ready SIndustries website content from raw notes and source material.

Used by Ivy. Can also be invoked directly by Quinn for one-off content tasks.

---

## Inputs

Provide all of these before starting. If any are missing, ask before proceeding.

| Input | Description | Required |
|---|---|---|
| `raw_notes` | Source material — task notes, weekly review item, release description, internal doc | yes |
| `target_type` | One of: `experiment`, `system`, `release`, `story`, `stack` | yes |
| `audience` | Who will read this. Default: "technically literate, curious builders" | no |
| `evidence_links` | URLs or internal paths that back up claims | no |
| `desired_tone` | E.g. "matter-of-fact", "founder note", "punchy one-liner" | no |
| `approval_risk_level` | `low`, `medium`, or `high` (see below) | yes |

### Approval risk levels (Approver)

- **low (Quinn approves)** — factual metadata, stack list update, experiment status change backed by task evidence, `currentLearning` additions with evidence
- **medium (Tom approves)** — release entry, system summary, story that references internal work without claiming external validation
- **high (Tom approves)** — first-person Tom voice, public strategic claim, revenue/customer/employer reference

---

## Outputs

Produce all of these, labelled clearly:

### 1. Card copy
Short text for homepage/listing card. Max 2 sentences. Specific and concrete — no filler.

### 2. Long-form draft
Full detail page body. Use headings where useful. Length matched to content type:
- experiment: 150–400 words
- system: 200–500 words
- release: 100–250 words
- story: 400–1200 words
- stack: 50–150 words

### 3. Meta description
1–2 sentences for SEO/sharing. Under 160 characters. No clickbait.

### 4. Suggested title and dek
- **Title:** Short. States what it is.
- **Dek:** One sentence. States why it matters or what's interesting.

### 5. Claim-risk notes
Flag each claim that needs evidence or approval. Format:

```
CLAIM: [exact text]
RISK: low | medium | high
REASON: [why it's risky or needs backing]
ACTION: [delete / add evidence link / needs Tom approval]
```

### 6. Review questions for Tom
Only include questions Tom genuinely needs to answer. Do not pad this section.
Examples:
- "Do you want to use first-person voice for this story, or keep it third-person?"
- "The current learning section references the NZ banking app — is that ready to mention publicly?"
- "Approval risk on the revenue line: should I remove it or do you want it in?"

---

## Copy principles

These are non-negotiable:

1. **Specific beats clever.** "Reduced deploy time from 45 min to 8 min" beats "dramatically faster deploys".
2. **Proof beats promise.** Link evidence. If there's no evidence, say so rather than imply it.
3. **No fake certainty.** Don't write "proven" or "best-in-class" without data.
4. **No first-person Tom copy without explicit approval.** Write in third person by default.
5. **No startup theater.** No "disrupting", "revolutionising", "game-changing".
6. **No private context.** Don't mention inMusic, family, salary, or anything that isn't already public.

---

## Content type field mappings

Content files live in the sindustries repo at:
```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/apps/website/src/content/
```

Each output maps to a JSON file in that directory:

| Type | File | Required fields |
|---|---|---|
| experiment | `experiments.json` | title, slug, status, summary, why, successCriteria, updatedAt, visibility |
| system | `systems.json` | title, slug, status, summary, problem, howItWorks, updatedAt, visibility |
| release | `releases.json` | title, slug, releasedAt, summary, type, visibility |
| story | `stories/[slug].json` | title, slug, dek, body, source, visibility |
| stack | `stacks.json` | title, slug, category, summary, updatedAt, visibility |

All new content starts with `visibility: "draft"` unless Tom explicitly sets it to `"published"`.

---

## Approval routing

After producing the outputs, route content to the correct PR:

Both PRs target the **sindustries repo** (`Stoffer-Industries/sindustries`), branching from `main`.
Branch names: `content/YYYY-MM-DD-tom` and `content/YYYY-MM-DD-quinn`.

**Tom-approval PR** — contains items with `approval_risk_level: medium` or `high`, or any first-person copy.
**Quinn-approval PR** — contains items with `approval_risk_level: low` only.

If a single content item has both low and high risk elements, split it: put the high-risk lines in the Tom PR and the safe version (with those lines removed or redacted) in the Quinn PR.

---

## Worked example

**Input:**
```
raw_notes: "Shipped content-ops Phase 1 last week — extracted all content from hardcoded JSX into JSON files. Took about 3 days of Rowan work. 4 content types now live."
target_type: release
approval_risk_level: low
```

**Card copy:**
> Content files extracted from JSX. Experiments, systems, releases, and stacks now live in JSON — editable without touching app code.

**Long-form draft:**
> Phase 1 of the SIndustries content ops build extracted all website content from hardcoded JSX into structured JSON files. Experiments, systems, releases, and stacks now have their own content files under `apps/website/src/content/`, editable independently of the app.
>
> This is the foundation for the content update loop — weekly reviews, Ivy-authored PRs, and eventual CMS tooling all depend on content being separable from code.

**Meta description:**
> SIndustries website content extracted to JSON. Updates no longer require code changes.

**Title:** Content files extracted from JSX
**Dek:** The first step in the SIndustries content ops loop — content is now code-independent.

**Claim-risk notes:**
```
CLAIM: "editable without touching app code"
RISK: low
REASON: factual — JSON files are in src/content, not JSX
ACTION: none
```

**Review questions for Tom:** (none for this item)
