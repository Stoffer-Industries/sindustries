---
name: idea-capture
description: "Capture a discovery conversation as a freeform idea doc in brain/ideas/ and create a linked task."
---

# Idea Capture

Use at the end of a discovery/design chat to anchor the idea before it's forgotten. No rigid structure — just enough to remember what was discussed and why it matters.

## When to use

- After a freeform design chat that produced something worth building
- When Tom says "write that up" or "create a task for this"
- Before the idea is ready for a formal spec

## Workflow

1. **Write the idea doc** to `brain/ideas/<slug>.md`
   - Slug: kebab-case, descriptive, no date prefix needed
   - Content: freeform — what problem, what the idea is, key decisions/constraints discussed, what's still unknown
   - Include a `## Context` section linking back to the conversation topic if relevant
   - No required sections, no ACs — this is discovery, not spec
   - Keep it short: 1-3 paragraphs is fine

2. **Create a task** via the Tasks API:
   ```
   POST http://localhost:4001/api/v1/tasks
   {
     "title": "<concise task title>",
     "description": "**Idea:** brain/ideas/<slug>.md\n\n<1-2 sentence summary of what this is>",
     "priority": "medium",
     "status": "open"
   }
   ```

3. **Confirm** with the task ID and a link to the idea doc.

## What NOT to do

- Don't write acceptance criteria (that's the spec's job)
- Don't write implementation details (that's the tech design's job)
- Don't force a structure — an idea doc can be bullet points, a paragraph, or a few questions
- Don't block on completeness — capture what you know now

## Pipeline position

```
Idea doc → Task (Open)
         → Spec written (pre-Ready)
         → Tech design written (pre-Doing)
         → PR → Done
```

The idea doc stays as provenance even after a spec exists.
