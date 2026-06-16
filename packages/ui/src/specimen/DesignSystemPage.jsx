import React, { useState } from 'react';
import { Button } from '../react/index.jsx';
import { SPECIMEN_PAGES } from './generated/pages.js';
import { SpecimenSection } from './SpecimenSections.jsx';
import './styles.css';

const KIT_TABS = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'pulse-react', label: 'Pulse' },
  { id: 'brand-react', label: 'Brand' }
];

function shellPackForPage(page) {
  return page?.pack ?? 'pulse';
}

export function DesignSystemPage({ backHref = '/', backLabel = '← Back' }) {
  const [activePageId, setActivePageId] = useState(SPECIMEN_PAGES[0]?.id ?? 'tokens');
  const [theme, setTheme] = useState('dark');
  const activePage = SPECIMEN_PAGES.find((page) => page.id === activePageId) ?? SPECIMEN_PAGES[0];
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  function selectPage(pageId) {
    const page = SPECIMEN_PAGES.find((entry) => entry.id === pageId);
    setActivePageId(pageId);
    if (page?.theme) setTheme(page.theme);
  }

  return (
    <main
      className="si-specimen-shell"
      data-si-theme={theme}
      data-si-pack={shellPackForPage(activePage)}
      data-si-surface="bgCanvas"
    >
      <header className="si-specimen-header">
        <a href={backHref} className="si-specimen-back">
          {backLabel}
        </a>
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
        <div className="si-specimen-header-actions">
          <p className="si-specimen-eyebrow">Design system</p>
          <Button
            type="button"
            variant="outline"
            aria-label={`Switch to ${nextTheme} theme`}
            onClick={() => setTheme(nextTheme)}
          >
            {theme === 'dark' ? 'Dark' : 'Light'}
          </Button>
        </div>
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
