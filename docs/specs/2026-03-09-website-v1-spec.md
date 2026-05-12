# Stoffer Industries Website V1 Spec

## Goal

Ship a credible public home page for Stoffer Industries that feels like a live operating company: fast, intentional, signal-rich, and easy to evolve.

This iteration replaces the initial three-page navigation concept with a long scrolling home page. The site should feel more alive: active systems, live-ish numbers, shipped work, experiments, and a clear path to follow or contact.

## Recommendation summary

- **Information architecture:** one long-scrolling home page
- **Navigation:** sticky horizontal section bar with jump links
- **Footer:** About and Contact live in the footer, not as primary pages
- **Content approach:** concise builder/operator copy; placeholders acceptable where real content is not ready
- **Implementation path:** evolve the existing `apps/website` Vite + React app
- **Design posture:** keep the existing SIndustries brand base, but make the page feel more dynamic and operational

## V1 success criteria

1. A visitor can understand what SIndustries is within a few seconds.
2. The site feels credible, alive, and in motion.
3. Navigation is section-based, not page-based.
4. The sticky section bar supports horizontal scrolling and jump navigation.
5. About and Contact are accessible from the footer.
6. Tom can review and adjust copy/design direction without a major rebuild.
7. The site runs locally and passes build/tests.

## Audience assumptions

Primary early audiences:

- people Tom knows who are checking out the brand
- potential collaborators or clients
- future users/customers landing from links or product references
- people following the build-in-public signal

Their first questions are likely:

- What is SIndustries?
- What is active right now?
- What systems/products are being built?
- Is there real momentum?
- How do I follow or contact Tom?

## Recommended home page sections

### 1. SIN

Intro / manifesto / who we are.

Should include:

- brand mark
- concise positioning
- primary follow/contact CTA
- a sense that the company is online and active

### 2. Signals

Live-ish proof points.

Examples:

- commits
- active projects
- systems online
- ships / releases
- experiments in progress

Metrics can be placeholder for now, but the visual language should anticipate real data later.

### 3. Systems

Hero cards for the main systems being built.

Example systems:

- OpenClaw
- Agent Ops
- Software Factory
- Commerce Loops

### 4. Stacks

The tools and operating model behind the work.

Examples:

- OpenClaw
- local models / Plano
- Codex / agent workflows
- Telegram / task workflows
- Vite / React / monorepo tooling

### 5. Ships

Completed work, changelog, demos, releases.

Purpose: prove that SIndustries ships, not just thinks.

### 6. Stories

Founder notes, lessons, posts, and public build narrative.

Placeholder story titles are acceptable.

### 7. Studio

Experiments and prototypes in motion.

This can feel more playful and unfinished.

### 8. Summon

Final CTA.

Should include:

- follow links
- email contact
- short invitation to collaborate / compare notes / follow the work

## Navigation behavior

- Remove the Home / About / Contact top navigation.
- Use a sticky horizontal section bar.
- The bar contains all section names: `SIN · Signals · Systems · Stacks · Ships · Stories · Studio · Summon`.
- On small screens, the bar scrolls horizontally.
- Section labels act as anchor jump links.
- Each section may have its own sticky header treatment so the current section feels pinned until the next section arrives.

## Footer

Footer contains:

- short About paragraph
- contact email
- X link
- TikTok link
- copyright/location

## Draft messaging

### Core positioning

**SIndustries builds practical digital products, agent systems, and operating loops in public.**

### Hero direction

- **Build the systems. Ship the signal.**
- SIndustries is Tom Stoffer’s AI-native builder/operator company: a place for tools, agents, workflows, and experiments that turn uncertainty into useful action.

### Contact CTA

If you are building, backing, or reshaping how organisations work, the line is open.

## Implementation details

### App shape

Use the existing `apps/website` Vite + React app.

Preferred scope:

- single scrolling home page
- section data hard-coded in React
- anchor navigation
- footer-based About / Contact
- no CMS
- no separate routes required for this iteration

### Styling approach

- keep CSS local and simple
- retain the existing bone/graphite/amber brand palette
- add more motion/state language through cards, status dots, rails, and signal panels
- avoid heavy animation or anything fragile
- optimise for clarity and momentum

## Non-goals for this iteration

- CMS integration
- blog/news backend
- real analytics dashboards
- live GitHub/API data feeds
- contact form backend
- legal pages
- product-specific drop page work

## Follow-up tasks to capture separately

- wire Signals to real data
- add real story/post content
- add screenshots or demos for Systems/Ships
- domain + deployment productionisation
- stronger SEO/social cards
- contact form if needed later

## Decision

Proceed with a single long-scrolling SIndustries home page using the section system above. Keep About and Contact in the footer. The drop microsite remains separate and should not receive this iteration.
