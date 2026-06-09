import { useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dropdown,
  DropdownDivider,
  DropdownOption,
  Field,
  Input,
  Select,
  Textarea,
  Toast
} from '@sindustries/ui/react';
import '../styles/tokens.css';

const TOKEN_SWATCH_ROWS = [
  [
    ['Canvas', 'var(--si-color-bg-canvas)'],
    ['Surface', 'var(--si-color-bg-surface)'],
    ['Surface alt', 'var(--si-color-bg-surface-alt)'],
    ['Surface contrast', 'var(--si-color-bg-surface-contrast)'],
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

export function DesignSystemPage() {
  const [theme, setTheme] = useState('dark');
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="token-specimen-shell" data-si-theme={theme}>
      <header className="token-specimen-header">
        <a href="/" className="token-specimen-back">
          ← Tasks
        </a>
        <div className="token-specimen-header-actions">
          <p className="token-specimen-eyebrow">Design system</p>
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
          <h1>Sindustries design system</h1>
          <p>
            Web view of the shared token contract and React component kit. Tokens come from{' '}
            <code>@sindustries/design-tokens/styles.css</code>, while components are rendered from{' '}
            <code>@sindustries/ui/react</code>.
          </p>
        </div>

        <section className="token-specimen-panel token-section">
          <p className="token-specimen-eyebrow">Components</p>
          <div className="component-specimen-grid">
            <article className="component-specimen-card">
              <h2>Buttons</h2>
              <div className="component-row">
                <Button variant="primary">Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
              </div>
              <p className="component-specimen-note">Display variants — square corners, hard shadow, display face.</p>
              <div className="component-row">
                <Button variant="primary" tone="display">Display primary</Button>
                <Button variant="outline" tone="display">Display outline</Button>
                <Button variant="ghost" tone="display">Display ghost</Button>
              </div>
            </article>

            <article className="component-specimen-card">
              <h2>Badges and avatar</h2>
              <div className="component-row">
                <Badge variant="urgent" tone="pulse">urgent</Badge>
                <Badge variant="high" tone="pulse">high</Badge>
                <Badge variant="medium" tone="pulse">medium</Badge>
                <Badge variant="low" tone="pulse">low</Badge>
                <Badge variant="tag" tone="pulse">#design</Badge>
                <Avatar aria-label="Assignee Rowan">R</Avatar>
              </div>
            </article>

            <Card variant="pulse" interactive className="component-task-card" tilt={1}>
              <div className="component-task-card__header">
                <strong>Tokenize task cards</strong>
                <Avatar aria-label="Assignee Quinn">Q</Avatar>
              </div>
              <p>Pulse-flavored card variant with tokenized hard corners, shadow, and tilt.</p>
              <div className="component-row">
                <Badge variant="medium" tone="pulse">medium</Badge>
                <Badge variant="status" tone="pulse">ready</Badge>
              </div>
            </Card>

            <article className="component-specimen-card">
              <h2>Form controls</h2>
              <div className="component-form-grid">
                <Field label="Title">
                  <Input placeholder="Task title" />
                </Field>
                <Field label="Priority">
                  <Select defaultValue="medium">
                    <option value="urgent">Urgent</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </Select>
                </Field>
                <Field label="Notes">
                  <Textarea rows={3} placeholder="Describe the work" />
                </Field>
              </div>
            </article>

            <article className="component-specimen-card">
              <h2>Dropdown</h2>
              <Dropdown role="menu" aria-label="Design system dropdown sample">
                <DropdownOption type="button" role="menuitem">Open</DropdownOption>
                <DropdownOption type="button" role="menuitem">Ready</DropdownOption>
                <DropdownDivider />
                <DropdownOption type="button" role="menuitem">Done</DropdownOption>
              </Dropdown>
            </article>

            <article className="component-specimen-card">
              <h2>Toast</h2>
              <div className="component-toast-stack">
                <Toast type="info">Design system loaded</Toast>
                <Toast type="success">Component styles verified</Toast>
                <Toast type="error">Example error state</Toast>
              </div>
            </article>
          </div>
        </section>

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
