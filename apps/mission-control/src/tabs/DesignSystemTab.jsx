import React from 'react';
import { DesignSystemPage } from '@sindustries/ui/specimen';

// Design System tab — hosts the shared DesignSystemPage specimen inside
// Mission Control. The specimen renders the design-kit navigation, theme
// toggle, and the kit pages (Tokens / Pulse / Brand) from
// packages/ui/src/specimen. The Mission Control tab bar IS the navigation;
// the back link is preserved to match the prior Tasks-app UX.
//
// This tab is intentionally simple: it has no data fetching, no toolbar,
// and no local state. The DesignSystemPage owns its own theme + kit-tab
// state.
export function DesignSystemTab() {
  return <DesignSystemPage backHref="/tasks" backLabel="← Tasks" />;
}
