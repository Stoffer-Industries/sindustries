import '../styles/tokens.css';

const TOKEN_SWATCHES = [
  ['Canvas', 'var(--si-color-bg-canvas)'],
  ['Surface', 'var(--si-color-bg-surface)'],
  ['Primary text', 'var(--si-color-text-primary)'],
  ['Muted text', 'var(--si-color-text-muted)'],
  ['Brand', 'var(--si-color-brand-500)'],
  ['Success', 'var(--si-color-success-500)'],
  ['Danger', 'var(--si-color-danger-500)'],
  ['Sage', 'var(--si-color-sage-500)'],
  ['Accent pink', 'var(--si-color-accent-500)']
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
  return (
    <main className="token-specimen-shell">
      <header className="token-specimen-header">
        <a href="/" className="token-specimen-back">
          ← Tasks
        </a>
        <p className="token-specimen-eyebrow">Design tokens</p>
      </header>

      <section className="token-specimen-page">
        <div className="token-specimen-panel token-specimen-intro">
          <h1>CSS token specimen</h1>
          <p>
            Web view of the shared token contract from{' '}
            <code>@sindustries/design-tokens/styles.css</code>. Compare with Pencil{' '}
            <code>tokens.pen</code> and <code>design-systems.pen</code>.
          </p>
        </div>

        <section className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Color</p>
          <div className="token-swatch-grid">
            {TOKEN_SWATCHES.map(([label, value]) => (
              <article className="token-swatch-card" key={label}>
                <span className="token-swatch" style={{ background: value }} />
                <strong>{label}</strong>
                <code>{value}</code>
              </article>
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

        <div className="token-specimen-two-up">
          <article className="token-specimen-panel token-section">
            <p className="token-specimen-eyebrow">Typography</p>
            <p className="token-display">Display face</p>
            <p className="token-ui">UI label and controls</p>
            <p className="token-body">Body copy for longer readable text.</p>
          </article>

          <article className="token-specimen-panel token-section">
            <p className="token-specimen-eyebrow">Shape and space</p>
            <div className="space-stack">
              {TOKEN_SPACES.map((space) => (
                <span key={space} style={{ width: `var(--si-space-${space})` }} />
              ))}
            </div>
            <div className="radius-grid">
              {TOKEN_RADII.map((radius) => (
                <span key={radius} style={{ borderRadius: `var(--si-radius-${radius})` }}>
                  {radius}
                </span>
              ))}
            </div>
          </article>
        </div>

        <section className="token-specimen-panel token-section token-component-row">
          <p className="token-specimen-eyebrow">Component sample</p>
          <div className="token-mini-card">
            <strong>Budget card</strong>
            <p>Shared surface, text, spacing, radius, and semantic status colors.</p>
          </div>
          <button type="button" className="token-primary-btn">
            Primary action
          </button>
          <span className="token-chip">Review needed</span>
        </section>
      </section>
    </main>
  );
}
