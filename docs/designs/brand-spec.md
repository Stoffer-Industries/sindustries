Brand Spec v0.3 — Stoffer Industries (SIN)

---

## 1. Brand Core

**Name**: SIndustries  
**Domain**: `sindustries.co.nz`  
**Shortmark**: SIN  
**Archetype**: The Builder-Operator  
**Essence**: Craft. Precision. Momentum.  
**Positioning**: SIndustries is a builder’s workshop for the modern era — designing, shipping, and operating digital products with speed, discipline, and long-term thinking.

Not an agency. Not a consultancy. A builder’s shop.

**Core belief**  
The systems we build today create the opportunities of tomorrow.  
Speed matters. Durability matters more.

---

## 2. Creative Direction

Inspired by the boldness of legacy skate / street brands (World Industries energy), but refined into a premium industrial aesthetic.

**Guiding idea**  
A modern industrial workshop.  
Not chaotic. Not corporate.  
Controlled intensity.

**Design principles**

- Bold, confident forms
- Minimal ornamentation
- Industrial cues without nostalgia
- Clean surfaces with subtle grit
- Strong iconography

Attitude should feel like competence under pressure, not rebellion.

---

## 3. Visual Language

**Shape Language**  
Industrial geometry.

- Hard corners
- Angled cuts
- Mechanical symmetry
- Structural diagonals

Shapes should feel machined, not illustrated.

**Motifs**

- Chevron / claw geometry
- Hazard-inspired striping
- Stamped industrial marks
- Structural frames and brackets

**Composition**

- Strong asymmetry
- Generous negative space
- Grid-aligned layouts
- Clear hierarchy

**Texture**

- The textured bone/off-white surface from the current logo assets is now the preferred default background surface.
- Use it as a tactile, premium base layer for marketing pages, landing pages, and brand-led surfaces.
- Keep the texture subtle: material depth, not distressed/grunge.
- Dark industrial panels can sit on top of the bone surface for contrast and hierarchy.
- Low opacity grain/noise overlays are acceptable when they reinforce the logo texture direction.

The goal: precision with a hint of workshop materiality — bone surface, graphite structure, amber signal.

---

## 5. Color System

**Source of truth:** `packages/design-tokens/tokens.json`  
Primitives become CSS variables (`--si-color-bone-100`, etc.); product code should prefer semantic tokens (`--si-color-bg-canvas`, `--si-color-text-primary`, …).

**Mantra:** bone surface, graphite structure, amber signal.

Think of the system like a workshop bench — mostly warm bone and cool graphite metal. Amber is the one calibrated tool you reach for. Pink, cyan, and status greens/reds are instrument panel lights: loud on purpose, rare by design.

---

### 5.1 Core primitives

Numbered scales run **higher = darker** unless noted.

#### Surfaces & structure

| Family | Key steps | Character | Role |
|--------|-----------|-----------|------|
| **Bone** | `50` `#f4f2ee` → `400` `#d5d3cd` | Warm off-white workshop surface | Light-mode backgrounds, fields, section chrome |
| **Ink** | `950` `#111213` → `800` `#1a1f24` | Near-black, subtle cool undertone | Dark canvas, deepest cards, hard shadows, Pulse ink borders |
| **Graphite** | `800` `#2b2f34` → `400` `#9CA3AF` | Cool blue-grey structure | Text on bone, borders, lifted dark sections, muted copy |
| **Paper** | `200` `#ece3cc` | Warm parchment | Dark-mode primary text (distinct from bone) |
| **Neutral** | `0` `#FFFFFF`, `200`/`300` greys | Flat neutral | Pure white sections, utility greys |

Ink and graphite share the same cool hue family; ink is environment depth, graphite is visible structure on top of it.

#### Signal & status

| Family | Key steps | Role |
|--------|-----------|------|
| **Brand** (amber) | `700` `#a76f00`, `500` `#ffc935`, `200` `#ffe891` | Secondary CTAs, dark-mode primary CTA, tertiary text in dark, priority badges; `700` for eyebrows/markers on bone |
| **Sage** | `500` `#7a8b7c` | Light-mode primary CTA, tertiary text in light |
| **Accent** (pink) | `500` `#ff3e8a`, `200` `#ff8ab4` | Urgent/blocked/draft Pulse badges |
| **Info** (cyan) | `500` `#00d4ff`, `200` `#9ee9ff` | Focus rings, informational toasts/tags, medium-priority badge fills |
| **Success** | `500` `#31c76a`, `200` `#9ee9b0` | Success status, ready/low badges |
| **Danger** | `500` `#ff5252` | Errors, destructive status |
| **Label** | blue / orange / purple | Tag and taxonomy chips (green aliases success) |

#### Utilities

- **Glass** — frosted overlays (`light` / `dark`)
- **Alpha** — subtle border tints for light and dark modes

---

### 5.2 Semantic tokens (how product code uses color)

Light and dark modes share the same semantic keys; values swap via `data-si-theme` on `:root`.

**Surface stack** (nesting, outside → in): `bgCanvas` → `bgSection` → `bgSurface`  
Related: `bgSectionHeader` (column chrome), `bgField` (inputs), `bgGlass`, `bgPaginationActive`, `bgImagePlaceholder`.

| Semantic token | Light mode | Dark mode |
|----------------|------------|-----------|
| `bgCanvas` | bone.100 | ink.950 |
| `bgSection` | bone.50 | graphite.800 |
| `bgSurface` | bone.150 | ink.800 |
| `bgSectionHeader` | bone.250 | ink.900 |
| `bgField` | bone.200 | ink.900 |
| `textPrimary` | graphite.800 | paper.200 |
| `textSecondary` | graphite.700 | graphite.500 |
| `textMuted` | graphite.600 | graphite.600 |
| `textTertiary` | sage.500 | brand.500 |
| `textOnDark` | bone.100 | bone.100 |
| `textOnDarkSecondary` | bone.400 | bone.400 |
| `borderStrong` | graphite.400 | graphite.500 |
| `ctaPrimary` | sage.500 | brand.500 |
| `ctaPrimaryText` | neutral.0 | ink.950 |
| `ctaSecondary` | brand.500 | sage.500 |
| `focus` | info.500 | info.500 |

Use semantic tokens in components. Reach for primitives when you need a fixed swatch (e.g. hard `ink.950` shadow offset on Pulse cards).

---

### 5.3 Where each mode shows up

**Light mode (bone + graphite)** — default for Pulse / tasks and the design-system specimen. Operator tools sit on a warm workshop surface with graphite type and structure. Sage carries the primary action; amber is the secondary signal.

**Dark mode (ink + graphite + paper)** — available in tasks via theme toggle. Canvas is deep ink; columns lift on graphite.800; cards sit on ink.800. Body copy reads in warm paper, not cold white.

**Marketing site** — light theme, bone-forward (`bone.50` canvas, subtle amber radial wash). Dark ink panels and amber/yellow CTAs provide contrast on top of the bone base; text on ink panels uses `textOnDark` / `textOnDarkSecondary`. Components come from `@sindustries/ui` with the **brand kit** (`data-si-pack="brand"`); editorial layout composes primitives directly rather than the full semantic surface stack.

---

### 5.4 UI element guidance

**Buttons**

- **Primary (light)** — white text on sage (`ctaPrimary`)
- **Primary (dark)** — ink text on amber (`ctaPrimary`)
- **Secondary** — amber (light) or sage (dark)
- **Pulse / brand chrome** — amber fills with `ink.950` borders and hard offset shadows

**Focus** — always cyan (`info.500`). Never amber. Amber is brand signal, not accessibility chrome.

**Badges (Pulse)**

- Priority medium / count → `info.200` fill
- High → `brand.200`
- Low / ready / success → `success.200`
- Blocked / draft → `accent.500`
- Tags → glass background or `statusInfo` outline

**Text hierarchy**

- On bone, use `textPrimary` / `textSecondary` / `textMuted` — not raw ink
- On dark panels, `paper.200` for primary text; reserve bone for light surfaces and on-danger foregrounds

---

### 5.5 Ratio & restraint

A healthy product screen is mostly **bone or ink environment + graphite text**, with accents as punctuation:

- **~85%** surfaces & structure (bone / ink / graphite)
- **~12%** text hierarchy (graphite / paper)
- **≤3%** amber, sage, cyan, pink, status hues combined

When accents become common, they stop being accents.

**Rules**

- Never large amber fields — sharp signal, not wallpaper
- Never amber body text on ink for paragraphs — tiring; amber is for labels, metrics, and short markers
- Cyan is for focus and info, not brand decoration
- Pink is for urgency/blocking, not general emphasis

**Brand graphics & print**

Monochrome ink + graphite compositions with a single amber marker (chevron, bar, underline) still read as on-brand. Physical materials map naturally: bone/paper stock, ink type, amber stamp.

**Signature gesture** — a recurring amber marker (vertical bar, chevron, slash) before headings works across web, product, and print without relying on the logo everywhere.

---

## 6. Typography System

**Source of truth:** `core.font` in `tokens.json`

| Token | Family | Role |
|-------|--------|------|
| `display` | Dela Gothic One | Hero words, Pulse button labels, stamped uppercase marks |
| `body` | Work Sans | Marketing copy, task content, long-form UI |
| `ui` | Inter | Dense controls, metadata, form labels, specimens |

Typography should reflect engineering clarity — machined, not expressive.

**Styling rules**

- Uppercase for labels, UI tags, and Pulse CTAs
- Dela Gothic One sparingly; it is the accent voice, not the workhorse
- Strict grid alignment
- No decorative typography

Text should feel engineered, not playful.

---

## 7. Logo & Mark System

**Primary Wordmark**  
STOFFER INDUSTRIES

**Alternate Wordmark**  
SINDUSTRIES

**Shortmark**  
SIN

**Icon Mark**  
Abstract industrial glyph based on:

- claw geometry
- directional chevron
- structural angle

The icon should feel like a stamped manufacturer’s mark.

**Important rule**  
The brand should never rely on mascots.  
Animal cues (tiger/claw energy) remain abstract in geometry, not literal.

---

## 8. Voice & Messaging

The voice should match the builder identity.

Not hype. Not corporate jargon.  
Direct. Calm. Confident.  
Write like someone who ships real things.

**Tone qualities**

- Precise
- Minimal
- Practical
- Thoughtful
- Slightly sharp

**Avoid**

- buzzwords
- exaggerated claims
- startup hype language

**Messaging Territory**

**Core narrative**  
Stoffer Industries builds and operates digital products with discipline and speed.  
What we build today creates the opportunities of tomorrow.

**Tagline Exploration**

Primary direction:

- Build What’s Next.

Alternatives:

- Built to Ship.
- Systems That Move.
- Precision in Motion.
- Built With Intent.
- What We Build Next.

These should feel confident and timeless, not aggressive.

**Copy Style**

Short sentences.  
Declarative language.

Example:

- **Bad**: We leverage cutting-edge technologies to drive scalable innovation.
- **Good**: We build systems. We ship them. Then we make them better.

---

## 9. Product & UI Style

Products from Stoffer Industries should reflect operator thinking.  
Tools built by someone who uses them.

**Principles**

- Theme-aware: light bone for daily operator work, dark ink when users want low-glare focus
- Dense but legible information
- Clear hierarchy via semantic color tokens, not one-off hex
- Minimal decoration — material comes from bone texture and graphite type, not ornament

**UI traits**

- One component set, multiple **kits** (style packs) in `@sindustries/ui`:
  - **Pulse kit** (tasks app): sharp `ink.950` borders, hard offset shadows, near-zero radius, display-face buttons. Opt-in per component (`tone="display"`, `variant="pulse"`).
  - **Brand kit** (marketing site): pill CTAs (amber primary + soft glow), hairline outline buttons that adapt to their surface, translucent editorial card surfaces, pill chips. Activated by context (`data-si-pack="brand"` on the page shell).
- Semantic surface stack for layout nesting (`bgCanvas` / `bgSection` / `bgSurface`)
- Bold status indicators (amber, cyan, pink, sage, success green)
- Cyan focus rings on all interactive elements
- Clear labels; metadata steps down `textSecondary` → `textMuted`; on ink panels use `textOnDark` → `textOnDarkSecondary`

**Motion**

Fast and purposeful.  
No bounce. No playful easing.  
Interfaces should feel like instruments, not toys.

---

## 10. Brand Summary

Stoffer Industries is a modern builder’s workshop.  
It exists to design, ship, and operate digital products with precision and speed.  
The brand balances industrial discipline with forward momentum.

Serious about craft. Comfortable with pressure. Focused on what comes next.  
Build today. Create tomorrow.
