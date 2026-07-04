import React from 'react';

export function BookmarksTab() {
  return (
    <section className="pulse-placeholder" data-testid="pulse-bookmarks-placeholder">
      <h2 className="pulse-placeholder__title">Bookmarks</h2>
      <p>
        The Bookmarks tab is tracked under a separate spec and is not part of
        the Pulse shell MVP. This tab exists to demonstrate the shell
        pattern — adding a new tab required only a route and a registry
        entry, no shell changes.
      </p>
    </section>
  );
}
