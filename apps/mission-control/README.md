# Pulse — `@sindustries/mission-control`

The Sindustries desktop shell. Hosts multiple tabs (Tasks, Bookmarks, Flow
metrics, Design System, Content) behind a single URL. The shell also owns
the day/night theme toggle (bottom of the vertical sidebar) and broadcasts
the chosen theme to iframe-based tabs via `pulse:theme` postMessage.

See `SPEC.md` for behaviour and `docs/specs/pulse-shell-app-tech-design.md`
for the design that introduced this app.

## Local development

```bash
# from repo root
npm install         # workspace install (npm workspaces)
npm --workspace @sindustries/mission-control run dev     # vite dev server
npm --workspace @sindustries/mission-control test        # vitest run
npm --workspace @sindustries/mission-control run build    # production bundle
```

The dev server runs on port 5173 by default. The shell assumes the Tasks
app is reachable on the same port (or one of the documented local dev
ports) and embeds it via iframe. The Tasks API base URL is resolved
automatically from the dev-server port, or overridden with
`VITE_TASKS_API_BASE_URL`.

The Bookmarks tab reads `brain/state/bookmark-review-state.json` and
`brain/state/bookmark-transitions.jsonl` via the dev-only Vite plugin in
`vite.config.js`. The plugin resolves the workspace `brain/` directory
via the `WORKSPACE_ROOT` env var, falling back to three levels up from
the Vite config. On a fresh checkout without `brain/`, the tab renders
an empty state rather than failing. Override the API base with
`VITE_BOOKMARK_STATE_BASE_URL` for non-local setups.

## Adding a new tab

1. Create a component in `src/tabs/DesignSystemTab.jsx` (or any `MyTab.jsx`).
2. Register it in `src/pulseTabs.jsx` with `id`, `label`, `path`, `icon`, and `component`.
3. Done — no App.jsx changes needed.

## Content tab

The Content tab surfaces the Content Scheduler — a single-user queue for
X posts. Items go through `queued → approved → published`; the publish
endpoint enforces "max one X post per day" in `Pacific/Auckland`. The
queue is read from `services/tasks-api`; see
`docs/specs/content-scheduler-tab-tech-design.md` for the full design and
`services/tasks-api/README.md` for the backend endpoints it depends on.
