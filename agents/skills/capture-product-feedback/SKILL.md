---
name: capture-product-feedback
description: "Capture product feedback in the owning initiative's brain/product-feedback.md file using a consistent dated format."
---

# Capture Product Feedback

## Purpose

Capture product feedback from hands-on use or user conversation in the owning initiative's Brain note, so observations remain findable and can later be converted into product opportunities or implementation tasks.

## When to use

Use when the user reports product feedback, UX friction, bugs observed during use, feature requests, or ideas tied to an existing product initiative.

Do not use for:

- generic brainstorming with no owning initiative;
- implementation task creation by itself;
- content/marketing feedback that belongs in a campaign or content review.

## Procedure

1. **Identify the owning initiative.**
   - Search `brain/initiatives/` for the product or project named by the user.
   - Read that initiative's `index.md` before writing.
   - If there is no unambiguous initiative, ask one concise clarifying question rather than inventing a new top-level location.

2. **Resolve the canonical feedback file.**
   - Prefer `brain/initiatives/<initiative>/product-feedback.md`.
   - If it exists, read it before editing and append to it.
   - If it does not exist, create it with the structure below and add a `Product feedback` link to the initiative's `index.md` under `Artifacts`.
   - Always use the workspace `brain/` symlink path, never a git worktree's `brain/` path.

3. **Capture the feedback faithfully.**
   - Preserve the user's meaning and important wording; do not silently turn a request into a technical design.
   - Group one capture session under a dated heading: `## YYYY-MM-DD — <short context>`.
   - Use one bullet per distinct observation.
   - Separate bugs, UX improvements, product opportunities, and research questions only when that makes the note clearer.
   - Include the source (for example, "Tom's hands-on session") and the initiative link near the top of the file.
   - Do not invent priority, acceptance criteria, estimates, or implementation scope unless the user supplied them.

4. **Avoid duplicates.**
   - Read the existing file and do not repeat an identical observation.
   - If the user is refining an existing item, update the existing bullet or add a dated refinement that clearly references it.

5. **Verify.**
   - Re-read the resulting feedback file and initiative index.
   - Confirm the file exists, the new entry is dated, and the initiative has a discoverable link.
   - Report the canonical path and briefly summarize what was captured.

## Canonical file template

```markdown
# <Product> — Product Feedback

**Initiative:** [<Product>](index.md)
**Last updated:** YYYY-MM-DD
**Source:** <source>

This is the running capture point for product feedback observed while using <Product>. Convert items into product opportunities or code tasks only after deciding scope and priority.

## YYYY-MM-DD — <short context>

- **<short label>:** <faithful observation>
```

## Guardrails

- Keep product feedback in the owning initiative directory.
- Do not create a task, spec, PR, or skill as a side effect unless separately requested.
- Do not overwrite existing feedback; append or make a targeted edit.
- Do not claim implementation or prioritisation has happened when only feedback was captured.
