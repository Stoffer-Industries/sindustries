# ScrollLinkedCardStack

Packaging candidate for a React scroll-linked sticky card stack.

## Current API

```jsx
import { ScrollLinkedCardStack } from './scroll-linked-card-stack';

<ScrollLinkedCardStack
  items={items}
  stickyTop={{ desktop: 78, mobile: 70 }}
  stackOffset={{ desktop: 18, mobile: 34 }}
  enterOffset={{ desktop: 620, mobile: 430 }}
  revealDistance={{ desktop: 460, mobile: 420 }}
  endBuffer={{ desktop: 280, mobile: 220 }}
  cardMinHeight="clamp(300px, 44vh, 460px)"
  headerMinHeight="clamp(110px, 14vw, 180px)"
  getKey={(item) => item.id}
  renderHeader={() => <Header />}
  renderCard={(item, index) => <Card item={item} index={index} />}
/>
```

## Design goals

- Card motion is tied directly to page scroll.
- No React state updates during scroll.
- Scroll loop reads only `window.scrollY`; bounds are cached on load/resize.
- Runtime writes only `transform` and `opacity` to card DOM nodes.
- The whole scene is one sticky parent, so the stack exits together.

## Files to package later

- `ScrollLinkedCardStack.jsx`
- `ScrollLinkedCardStack.css`
- `index.js`

## Still SIndustries-specific outside this folder

The generic component owns behaviour and structural CSS only. Visual styling lives in `App.css` under `.si-sticky-card-stack ...` and should remain outside a package, or become optional theme CSS.
