import { useState } from 'react';
import '../styles/tokens.css';

const TOKEN_SWATCH_ROWS = [
  [
    ['Canvas', 'var(--si-color-bg-canvas)'],
    ['Surface', 'var(--si-color-bg-surface)'],
    ['Primary text', 'var(--si-color-text-primary)'],
    ['Muted text', 'var(--si-color-text-muted)']
  ],
  [
    ['Brand', 'var(--si-color-brand-500)'],
    ['Accent Pink', 'var(--si-color-accent-500)'],
    ['Sage', 'var(--si-color-sage-500)']
  ],
  [
    ['Success', 'var(--si-color-success-500)'],
    ['Danger', 'var(--si-color-danger-500)']
  ]
];

const TOKEN_LABELS = [
  ['Green', 'var(--si-color-label-green)'],
  ['Blue', 'var(--si-color-label-blue)'],
  ['Orange', 'var(--si-color-label-orange)'],
  ['Purple', 'var(--si-color-label-purple)'],
  ['Gray', 'var(--si-color-label-gray)']
];

const TOKEN_SPACES = ['1', '2', '3', '4', '5', '6', '7', '8', '10'];
const TOKEN_RADII = ['sm', 'md', 'lg', 'xl', 'pill'];

export function TokensPage() {
  const [theme, setTheme] = useState('dark');
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="token-specimen-shell" data-si-theme={theme}>
      <header className="token-specimen-header">
        <a href="/" className="token-specimen-back">
          ← Tasks
        </a>
        <div className="token-specimen-header-actions">
          <p className="token-specimen-eyebrow">Design tokens</p>
          <button
            type="button"
            className="token-theme-toggle"
            aria-label={`Switch to ${nextTheme} theme`}
            onClick={() => setTheme(nextTheme)}
          >
            {theme === 'dark' ? 'Dark' : 'Light'}
          </button>
        </div>
      </header>

      <section className="token-specimen-page">
        <div className="token-specimen-panel token-specimen-intro">
          <h1>CSS token specimen</h1>
          <p>
            Web view of the shared token contract from{' '}
            <code>@sindustries/design-tokens/styles.css</code>. Compare with Pencil{' '}
            <code>design-systems.pen</code>.
          </p>
        </div>

        <section className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Color</p>
          <div className="token-swatch-rows">
            {TOKEN_SWATCH_ROWS.map((row) => (
              <div className="token-swatch-grid" key={row.map(([label]) => label).join('-')}>
                {row.map(([label, value]) => (
                  <article className="token-swatch-card" key={label}>
                    <span className="token-swatch" style={{ background: value }} />
                    <strong>{label}</strong>
                    <code>{value}</code>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Color labels</p>
          <div className="token-swatch-grid">
            {TOKEN_LABELS.map(([label, value]) => (
              <article className="token-swatch-card" key={label}>
                <span className="token-swatch" style={{ background: value }} />
                <strong>{label}</strong>
                <code>{value}</code>
              </article>
            ))}
          </div>
        </section>

        <article className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Typography</p>
          <p className="token-display">Display face</p>
          <p className="token-ui">UI label and controls</p>
          <p className="token-body">Body copy for longer readable text.</p>
        </article>

        <article className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Space</p>
          <div className="space-stack">
            {TOKEN_SPACES.map((space) => (
              <span className="space-item" key={space}>
                <span className="space-bar" style={{ width: `var(--si-space-${space})` }} />
                <code>{space}</code>
              </span>
            ))}
          </div>
        </article>

        <article className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Radius</p>
          <div className="radius-grid">
            {TOKEN_RADII.map((radius) => (
              <span key={radius} style={{ borderRadius: `var(--si-radius-${radius})` }}>
                {radius}
              </span>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
