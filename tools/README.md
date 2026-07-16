# Tools

Local development utilities for the Sindustries repo. Each subdirectory
ships a self-contained entry point (Python script, static HTML, etc.).

## Bookmark pipeline dashboard

The bookmark pipeline dashboard is now served from **Mission Control**
at `/bookmarks`. The previous standalone `tools/bookmark-dashboard/`
(static HTML + Python `serve.py`) was retired on 2026-07-16 as part of
the Bookmarks-tab port (AC10 of
`b179c0e3-c6b0-4c9d-97dc-982d3b841783`).

If you're looking for the bookmark Sankey, the states-over-time chart,
the curation pipeline funnel, or the per-topic count breakdown, run
Mission Control locally and visit `/bookmarks`. The standalone `serve.py`
script no longer ships.