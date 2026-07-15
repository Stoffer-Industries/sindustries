import React, { useEffect, useState } from 'react';
import { SPECIMEN_PAGES } from './generated/pages.js';
import { SpecimenSection } from './SpecimenSections.jsx';
import './styles.css';

// Kit tabs are derived from SPECIMEN_PAGES so adding a page only requires
// editing the generated manifest. The tabLabel mapping preserves the
// short labels the existing tests assert against.
const KIT_TAB_LABELS = {
  tokens: 'Tokens',
  'pulse-react': 'Pulse',
  'brand-react': 'Brand'
};

const KIT_TABS = SPECIMEN_PAGES.map((page) => ({
  id: page.id,
  label: KIT_TAB_LABELS[page.id] ?? page.id
}));

function shellPackForPage(page) {
  return page?.pack ?? 'pulse';
}

// Read the shell's current data-si-theme attribute (Mission Control
// owns it on <html>; tests can simulate by setting it on documentElement).
// Falls back to 'dark' so SSR / no-DOM callers get a deterministic value.
function readShellTheme() {
  if (typeof document === 'undefined') return 'dark';
  const value = document.documentElement.getAttribute('data-si-theme');
  return value === 'light' ? 'light' : 'dark';
}

/**
 * DesignSystemPage — design-kit specimen viewer used by Mission Control's
 * Design System tab and (historically) the Tasks app.
 *
 * Per AC5/AC6 of task 205d7615 (Design System tab in Mission Control),
 * the page no longer owns its own in-page theme toggle or back link:
 *   - The shell's Day/Night sidebar toggle is the single source of truth
 *     for `data-si-theme`. We track <html data-si-theme> via a
 *     MutationObserver so theme flips propagate without a remount.
 *   - Navigation lives in the Mission Control tab bar; the in-page back
 *     link to "/tasks" is redundant and has been removed.
 *
 * Per-kit-page overrides (`SPECIMEN_PAGES[*].theme`) still apply to the
 * individual section element (e.g. the Brand kit renders `data-si-theme="light"`
 * on its own section so its pale palette survives the shell being dark).
 */
export function DesignSystemPage() {
  const [activePageId, setActivePageId] = useState(SPECIMEN_PAGES[0]?.id ?? 'tokens');
  const [shellTheme, setShellTheme] = useState(readShellTheme);

  // Mirror the shell's data-si-theme attribute. Mission Control sets it
  // on <html> via the sidebar ThemeToggle; this observer keeps the
  // specimen shell in sync without a reload or remount.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    setShellTheme(readShellTheme());
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      const next = readShellTheme();
      setShellTheme((current) => (current === next ? current : next));
    });
    observer.observe(target, { attributes: true, attributeFilter: ['data-si-theme'] });
    return () => observer.disconnect();
  }, []);

  const activePage = SPECIMEN_PAGES.find((page) => page.id === activePageId) ?? SPECIMEN_PAGES[0];

  function selectPage(pageId) {
    setActivePageId(pageId);
  }

  return (
    <main
      className="si-specimen-shell"
      data-si-theme={shellTheme}
      data-si-pack={shellPackForPage(activePage)}
      data-si-surface="bgCanvas"
    >
      <header className="si-specimen-header">
        <nav className="si-specimen-kit-tabs" aria-label="Design kit">
          {KIT_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`si-specimen-kit-tab${tab.id === activePageId ? ' si-specimen-kit-tab--active' : ''}`}
              aria-current={tab.id === activePageId ? 'page' : undefined}
              onClick={() => selectPage(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="si-specimen-page">
        {activePage ? (
          <section
            key={activePage.id}
            id={activePage.id}
            className="si-specimen-page-block"
            data-si-pack={activePage.pack ?? undefined}
            data-si-theme={activePage.theme ?? undefined}
          >
            <div className="si-specimen-panel si-specimen-intro">
              <p className="si-specimen-eyebrow">{activePage.eyebrow}</p>
              <h1>{activePage.title}</h1>
              <p>{activePage.intro}</p>
            </div>
            {activePage.sections.map((section) => (
              <SpecimenSection key={`${activePage.id}-${section.id}`} section={section} page={activePage} />
            ))}
          </section>
        ) : null}
      </div>
    </main>
  );
}