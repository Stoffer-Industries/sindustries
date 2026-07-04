# Pulse — `@sindustries/mission-control`

The Sindustries desktop shell. Hosts multiple tabs (Tasks, Bookmarks, Flow
metrics) behind a single URL.

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

## Adding a new tab

1. Create a component in `src/tabs/MyTab.jsx`.
2. Register it in `src/pulseTabs.js`.
3. Done — no App.jsx changes needed.
