import React, { useState } from 'react';
import { Button } from '../react/index.jsx';
import { SPECIMEN_PAGES } from './generated/pages.js';
import { SpecimenSection } from './SpecimenSections.jsx';
import './styles.css';

export function DesignSystemPage({ backHref = '/', backLabel = '← Back' }) {
  const [theme, setTheme] = useState('dark');
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="si-specimen-shell" data-si-theme={theme} data-si-pack="pulse" data-si-surface="page">
      <header className="si-specimen-header">
        <a href={backHref} className="si-specimen-back">
          {backLabel}
        </a>
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
        {SPECIMEN_PAGES.map((page) => (
          <section key={page.id} id={page.id} className="si-specimen-page-block">
            <div className="si-specimen-panel si-specimen-intro">
              <p className="si-specimen-eyebrow">{page.eyebrow}</p>
              <h1>{page.title}</h1>
              <p>{page.intro}</p>
            </div>
            {page.sections.map((section) => (
              <SpecimenSection key={`${page.id}-${section.id}`} section={section} page={page} />
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
