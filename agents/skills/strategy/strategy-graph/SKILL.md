---
name: strategy-graph
description: "Reason about Sindustries strategy as a traversable graph — entities, relationships, impact propagation, and strategic questions."
---

# Strategy Graph

This skill is a reasoning framework, not a database schema. The graph's value is in traversal — answering questions that cross levels of the strategy stack. Entities are secondary to the relationships between them.

Apply this whenever Tom asks a strategy question, when creating/reviewing features or initiatives, or when evaluating impact of a priority change.

---

## The Graph Model

### Two Planning Directions

**Top-down (Business Strategy):** Leadership defines direction.
```
Strategy → Themes → Objectives → Initiatives
Strategy ↔ Portfolio → Value Streams → ARTs
Theme ↔ Value Stream
```

**Bottom-up (Customer Value):** Delivery informs what's worth building.
```
Features → Phases → Stories
Features prioritised by Impact
```

**The roadmap emerges at the intersection.**

### Full Relationship Map

| From | Rel | To | Cardinality |
|------|-----|----|-------------|
| Strategy | ↔ | Portfolio | 1:1 |
| Strategy | → | Themes | 1:many |
| Portfolio | → | Value Streams | 1:many |
| Theme | ↔ | Value Stream | many:many |
| Value Stream | → | ARTs | 1:many |
| Theme | → | Objectives | 1:many |
| Theme | → | Impacts | 1:many |
| Initiative | ↔ | Impacts | many:many |
| Initiative | → | Features | 1:many |
| Feature | → | Phases | 1:many |
| Phase | → | Stories | 1:many |

### Core Concept: Impact

Impact is the bridge between strategy and delivery. It answers "why does this matter to a customer?"

- An Initiative can deliver many Impacts.
- An Impact can be addressed by many Initiatives.
- When Initiatives change priority, recalculate which Impacts are covered and which customer outcomes are at risk.

Features can represent software, marketing, sales, or operational work — any delivery artifact.

---

## Traversal Patterns

When asked a strategic question, traverse the graph in the right direction before answering.

### "Why does this feature exist?"
Traverse upward: Feature → Initiative → Impacts → Theme → Strategy

### "What changes if we double down on Theme X?"
Traverse downward: Theme → Objectives + Impacts → Initiatives → Features
Then surface: which teams, which customer outcomes, which current work accelerates or conflicts.

### "What happens if we deprioritise Initiative Y?"
Find all Impacts connected to Y. Check if other Initiatives cover those Impacts. If not, surface the uncovered customer outcomes to Tom.

### "Which initiatives have the greatest leverage?"
Score by: number of Impacts connected × breadth of Themes covered × current delivery momentum.

### "What does this feature actually deliver for customers?"
Feature → Initiative → Impacts → customer outcomes. If this chain can't be completed, the feature needs justification.

### "If strategy changes at the top, what ripples down?"
Strategy delta → affected Themes → Objectives/Impacts that shift → Initiatives to re-prioritise → Features to accelerate, pause, or kill.

---

## Dynamic Roadmapping

The graph is the source of truth. When strategy changes:
1. Update Theme and Initiative priorities.
2. Relationship mappings remain stable.
3. Impacts stay linked to customer value.
4. Feature priorities recalculate automatically from impact coverage.

Never rebuild the roadmap manually. Traverse the graph and let priorities emerge.

---

## Operational Use

Keep the model **semi-structured**. Quinn owns evolving and documenting relationships — no heavy schema enforcement.

When discussing strategy with Tom:
- Name entities explicitly (Theme, Initiative, Impact, etc.) so the vocabulary stays shared
- When a new initiative or feature comes up, ask "which Impacts does this address?" and "which Theme does it serve?"
- Document new relationships as they're surfaced in conversation

When Tom asks a strategic question:
1. Identify which traversal pattern applies
2. Traverse explicitly — say which path you're following
3. Surface gaps: orphaned features (no upward connection), Impacts with no covering Initiative, Themes with no delivery

### Sindustries Scale Note
Sindustries currently has one ART and one Value Stream. Treat these as "the whole team" — the SAFe vocabulary maps fine, just don't over-rotate on the multi-team implications.

---

## Entity Glossary

| Entity | Definition |
|--------|-----------|
| **Strategy** | The top-level direction and intent of the business |
| **Portfolio** | The collection of value streams aligned to the strategy |
| **Theme** | A strategic focus area grouping related objectives and impacts |
| **Objective** | A measurable outcome under a theme |
| **Value Stream** | End-to-end flow of value to a customer segment |
| **ART** | Cross-functional team aligned to a value stream |
| **Impact** | A specific customer outcome — the bridge between strategy and delivery |
| **Initiative** | A bounded body of work contributing to one or more impacts |
| **Feature** | A deliverable (software, marketing, sales, ops) that implements an initiative |
| **Phase** | A time-boxed slice of feature delivery |
| **Story** | A granular unit of work within a phase |

---

## Long-term Vision

Quinn becomes a strategic reasoning agent able to answer:
- Why does this feature exist?
- Which strategic themes does it support?
- What customer impacts justify it?
- What changes if leadership reprioritises strategy?
- Which initiatives have the greatest leverage?

The front-end visualisation tool (future) will render the same graph Quinn reasons over. Ground truth first, UI second.
