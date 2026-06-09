import React, { useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Divider,
  Dropdown,
  DropdownDivider,
  DropdownOption,
  Field,
  Input,
  Select,
  Textarea,
  Toast,
  Tooltip
} from '../react/index.jsx';
import {
  SPECIMEN_COLOR_ROWS,
  SPECIMEN_LABEL_COLORS,
  SPECIMEN_RADII,
  SPECIMEN_SPACES
} from './manifest.js';
import './styles.css';

export function DesignSystemPage({ backHref = '/', backLabel = '← Back' }) {
  const [theme, setTheme] = useState('dark');
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="si-specimen-shell" data-si-theme={theme}>
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

      <section className="si-specimen-page">
        <div className="si-specimen-panel si-specimen-intro">
          <h1>Sindustries design system</h1>
          <p>
            Web view of the shared token contract and React component kit. Tokens come from{' '}
            <code>@sindustries/design-tokens/styles.css</code>, while components are rendered from{' '}
            <code>@sindustries/ui/react</code>.
          </p>
        </div>

        <section className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Components</p>
          <div className="si-specimen-component-grid">
            <article className="si-specimen-card">
              <h2>Buttons</h2>
              <div className="si-specimen-row">
                <Button variant="primary">Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
              </div>
              <p className="si-specimen-note">Display variants — square corners, hard shadow, display face.</p>
              <div className="si-specimen-row">
                <Button variant="primary" tone="display">Display primary</Button>
                <Button variant="outline" tone="display">Display outline</Button>
                <Button variant="ghost" tone="display">Display ghost</Button>
              </div>
            </article>

            <article className="si-specimen-card">
              <h2>Badges, tooltip, and avatar</h2>
              <div className="si-specimen-row">
                <Badge variant="urgent" tone="pulse">urgent</Badge>
                <Badge variant="high" tone="pulse">high</Badge>
                <Badge variant="medium" tone="pulse">medium</Badge>
                <Badge variant="low" tone="pulse">low</Badge>
                <Badge variant="tag" tone="pulse">#design</Badge>
                <Tooltip>3</Tooltip>
                <Avatar aria-label="Assignee Rowan">R</Avatar>
              </div>
            </article>

            <Card variant="pulse" interactive className="si-specimen-task-card" tilt={1}>
              <div className="si-specimen-task-card__header">
                <strong>Tokenize task cards</strong>
                <Avatar aria-label="Assignee Quinn">Q</Avatar>
              </div>
              <p>Pulse-flavored card variant with tokenized hard corners, shadow, and tilt.</p>
              <div className="si-specimen-row">
                <Badge variant="medium" tone="pulse">medium</Badge>
                <Badge variant="status" tone="pulse">ready</Badge>
              </div>
            </Card>

            <article className="si-specimen-card">
              <h2>Form controls</h2>
              <div className="si-specimen-form-grid">
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

            <article className="si-specimen-card">
              <h2>Dividers</h2>
              <div className="si-specimen-form-grid">
                <div>
                  <p className="si-specimen-note">Dashed — task card sections</p>
                  <Divider variant="dashed" />
                </div>
                <div>
                  <p className="si-specimen-note">Subtle — inline separators</p>
                  <Divider variant="subtle" />
                </div>
              </div>
            </article>

            <article className="si-specimen-card">
              <h2>Dropdown</h2>
              <Dropdown role="menu" aria-label="Design system dropdown sample">
                <DropdownOption type="button" role="menuitem">Open</DropdownOption>
                <DropdownOption type="button" role="menuitem">Ready</DropdownOption>
                <DropdownDivider />
                <DropdownOption type="button" role="menuitem">Done</DropdownOption>
              </Dropdown>
            </article>

            <article className="si-specimen-card">
              <h2>Toast</h2>
              <div className="si-specimen-toast-stack">
                <Toast type="info">Design system loaded</Toast>
                <Toast type="success">Component styles verified</Toast>
                <Toast type="error">Example error state</Toast>
              </div>
            </article>
          </div>
        </section>

        <section className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Color</p>
          <div className="si-specimen-swatch-rows">
            {SPECIMEN_COLOR_ROWS.map((row) => (
              <div className="si-specimen-swatch-grid" key={row.map(([label]) => label).join('-')}>
                {row.map(([label, value]) => (
                  <article className="si-specimen-swatch-card" key={label}>
                    <span className="si-specimen-swatch" style={{ background: value }} />
                    <strong>{label}</strong>
                    <code>{value}</code>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Color labels</p>
          <div className="si-specimen-swatch-grid">
            {SPECIMEN_LABEL_COLORS.map(([label, value]) => (
              <article className="si-specimen-swatch-card" key={label}>
                <span className="si-specimen-swatch" style={{ background: value }} />
                <strong>{label}</strong>
                <code>{value}</code>
              </article>
            ))}
          </div>
        </section>

        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Typography</p>
          <p className="si-specimen-type-display">Display face</p>
          <p className="si-specimen-type-ui">UI label and controls</p>
          <p className="si-specimen-type-tertiary">Tertiary headers</p>
          <p className="si-specimen-type-body">Body copy for longer readable text.</p>
        </article>

        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Space</p>
          <div className="si-specimen-space-stack">
            {SPECIMEN_SPACES.map((space) => (
              <span className="si-specimen-space-item" key={space}>
                <span className="si-specimen-space-bar" style={{ width: `var(--si-space-${space})` }} />
                <code>{space}</code>
              </span>
            ))}
          </div>
        </article>

        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">Radius</p>
          <div className="si-specimen-radius-grid">
            {SPECIMEN_RADII.map((radius) => (
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
