# AI Agent Instructions

Your task is to implement **Pulse**. This application was specified and
designed by the user in a tool called Mowgli (https://mowgli.ai). This directory
contains the extracted contents of the Mowgli export.

## Package Contents

This package contains:
- `SPEC.md`: Complete application specification including user journeys, data model, and frontend screens
- `screens/*.tsx`: React + Tailwind design mockups for each screen (static,
  non-functional - use this as STRICT design reference as you go, but wire it up
  properly)
- `screens/images/`: Images used in the designs

## How to Proceed

### If IMPLEMENTATION_PLAN.md does not exist:

Before writing any code, interview the user to understand their level of
technical prowess, project context, and technical preferences.

Start off by understanding if the contents of this package are standalone, or
integrate with some existing project or codebase.

If the app is designed in a mobile fashion, understand if the user wants an
ordinary React PWA, an Expo app (very common), or a native mobile app.

Make sure you understand the scope (frontend, backend, database, auth,
deployment) and suggest good options if the user is non-technical (Next.js/Expo,
Supabase, Vercel).

Ask about any specific conventions or patterns they follow.

If you have tools for asking user questions, use them.

After gathering requirements, create `IMPLEMENTATION_PLAN.md` with:
- User context
- Technical stack summary
- Detailed implementation tasks organized vertically, by user journey (from the spec)
- Checkboxes for each task so progress can be tracked
- File structure plan

### If IMPLEMENTATION_PLAN.md exists:

Continue implementation according to the plan:
1. Read the plan and find the next uncompleted task
2. Implement one chunk of work, following the spec and using the screen designs as reference
3. Mark the task as complete with [x]
4. Move to the next task

## Important Notes

- The screen `.tsx` files are **design mockups only** - they render static data and have no real functionality
- The user has signed off on their visual appearance in Mowgli, so use them
  extensively as visual reference + copy styling, but implement real data binding
  and state management
- The `SPEC.md` is the source of truth for behavior and requirements
- When implementing a screen, refer to both the spec (for behavior) and the
  `.tsx` file (for design)
