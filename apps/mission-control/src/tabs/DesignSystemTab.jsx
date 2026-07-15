import React from 'react';
import { DesignSystemPage } from '@sindustries/ui/specimen';

// Design System tab — hosts the shared DesignSystemPage specimen inside
// Mission Control.
//
// The Mission Control tab bar IS the navigation, so the page no longer
// renders an in-page back link (AC5). The shell's Day/Night sidebar
// toggle owns `data-si-theme`; the specimen follows that attribute via
// its own MutationObserver, so the design system tab picks up shell
// theme flips without a remount (AC6).
export function DesignSystemTab() {
  return <DesignSystemPage />;
}