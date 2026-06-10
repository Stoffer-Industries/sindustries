import React from 'react';
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
  SearchInput,
  Select,
  Textarea,
  Toast,
  Tooltip
} from '../react/index.jsx';
import { COMPONENT_CATALOG } from './generated/catalog.js';
import {
  SPECIMEN_COLOR_ROWS,
  SPECIMEN_LABEL_COLORS,
  SPECIMEN_RADII,
  SPECIMEN_SPACES
} from './generated/manifest.js';

const COMPONENT_MAP = {
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
  SearchInput,
  Select,
  Textarea,
  Toast,
  Tooltip
};

function renderDemo(demo, key) {
  const Component = COMPONENT_MAP[demo.component];
  if (!Component) return null;
  return <Component key={key} {...demo.props} />;
}

function PenRefChip({ penRef }) {
  if (!penRef?.name) return null;
  return <span className="si-specimen-pen-ref">{penRef.name}</span>;
}

function DemoRow({ demos }) {
  const penRefs = demos.filter((demo) => demo.penRef?.name);
  return (
    <div className="si-specimen-demo-block">
      <div className="si-specimen-row">{demos.map((demo, index) => renderDemo(demo, index))}</div>
      {penRefs.length ? (
        <div className="si-specimen-pen-refs" aria-label="Pencil component names">
          {penRefs.map((demo, index) => (
            <PenRefChip key={`${demo.penRef.name}-${index}`} penRef={demo.penRef} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function groupCatalogComponents(group) {
  if (group.catalogComponents?.length) return group.catalogComponents;
  if (group.catalogComponent) return [group.catalogComponent];
  return [];
}

function inlineCatalogComponents(pack) {
  return new Set(
    COMPONENT_CATALOG.specimenGroups
      .filter((group) => group.pack === pack)
      .flatMap((group) => groupCatalogComponents(group))
  );
}

function catalogVariantText(packEntry) {
  const parts = [
    ...(packEntry.variants ?? []),
    ...(packEntry.tones?.map((tone) => `tone:${tone}`) ?? []),
    ...(packEntry.states?.map((state) => `state:${state}`) ?? [])
  ];
  return parts.length ? parts.join(', ') : '—';
}

function CatalogFields({ name, entry, pack }) {
  const packEntry = entry.packs[pack];
  return (
    <>
      <div className="si-specimen-catalog-row__head">
        <strong>{name}</strong>
        <span className={`si-specimen-catalog-status si-specimen-catalog-status--${packEntry.status}`}>
          {packEntry.status.toUpperCase()}
        </span>
      </div>
      <p className="si-specimen-catalog-line si-specimen-catalog-line--path">
        .{entry.cssPrefix} · {COMPONENT_CATALOG.exportPath}
        {entry.penComponentId ? ` · pen:${entry.penComponentId}` : ''}
      </p>
      <p className="si-specimen-catalog-line">variants: {catalogVariantText(packEntry)}</p>
      <p className="si-specimen-catalog-line">{COMPONENT_CATALOG.sourcePath}</p>
      {packEntry.penNames?.length ? (
        <p className="si-specimen-catalog-line si-specimen-catalog-line--pen">
          pen: {packEntry.penNames.join(', ')}
        </p>
      ) : null}
    </>
  );
}

function CatalogRow({ name, entry, pack }) {
  return (
    <div className="si-specimen-catalog-row">
      <CatalogFields name={name} entry={entry} pack={pack} />
    </div>
  );
}

function SpecimenGroupPanel({ group, pack }) {
  const catalogNames = groupCatalogComponents(group);

  return (
    <div className="si-specimen-group-panel" data-si-surface="group">
      <h2 className="si-specimen-group-title">{group.title}</h2>
      <div className="si-specimen-group-panel__body">
        <div className="si-specimen-group-panel__demos">
          <SpecimenGroupContent group={group} />
        </div>
        {catalogNames.length ? (
          <div className="si-specimen-group-panel__catalog" data-si-surface="inset">
            <p className="si-specimen-code-label">CODE</p>
            {catalogNames.map((name) => {
              const entry = COMPONENT_CATALOG.components[name];
              if (!entry) return null;
              return (
                <div key={name} className="si-specimen-catalog-inline-entry">
                  <CatalogFields name={name} entry={entry} pack={pack} />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SpecimenGroupContent({ group }) {
  return (
    <>
      {group.rows?.map((row, index) => (
        <React.Fragment key={index}>
          <DemoRow demos={row.demos} />
          {index === 0 && group.note ? <p className="si-specimen-note">{group.note}</p> : null}
        </React.Fragment>
      ))}
      {group.kind === 'pulseTaskCard' ? (
        <Card variant="pulse" interactive className="si-specimen-task-card task-card" tilt={1}>
          <strong className="task-card-title">Fix task creation API - returns null on success</strong>
          <div className="task-card-footer">
            <div className="task-card-footer-tags">
              <Badge variant="urgent" tone="pulse">urgent</Badge>
              <Badge variant="tag" tone="pulse">api</Badge>
              <Badge variant="tag" tone="pulse">backend</Badge>
            </div>
            <div className="task-card-footer-meta">
              <Avatar aria-label="Assignee PJ">PJ</Avatar>
              <time className="task-card-date" dateTime="2026-03-07">2026-03-07</time>
            </div>
          </div>
        </Card>
      ) : null}
      {group.kind === 'formControls' ? (
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
          <SearchInput placeholder="Search…" />
        </div>
      ) : null}
      {group.kind === 'dividers' ? (
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
      ) : null}
      {group.kind === 'dropdown' ? (
        <Dropdown role="menu" aria-label="Design system dropdown sample">
          <DropdownOption type="button" role="menuitem">Open</DropdownOption>
          <DropdownOption type="button" role="menuitem">Ready</DropdownOption>
          <DropdownDivider />
          <DropdownOption type="button" role="menuitem">Done</DropdownOption>
        </Dropdown>
      ) : null}
      {group.kind === 'toast' ? (
        <div className="si-specimen-toast-stack">
          <Toast
            type="info"
            title="Rover status update"
            description="Spirit-9 completed its nightly diagnostics. All systems are running within optimal parameters."
          />
          <Toast
            type="success"
            title="Mission approved"
            description="Your request to rent the Curiosity-X rover has been confirmed. Deployment scheduled for Sol 482."
          />
          <Toast
            type="error"
            title="Communication link lost"
            description="Rover telemetry signal interrupted. Check your base antenna alignment or retry connection in 10 minutes."
          />
        </div>
      ) : null}
      {group.penEmbeds?.length ? (
        <div className="si-specimen-pen-refs" aria-label="Pencil component names">
          {group.penEmbeds.map((penRef, index) => (
            <PenRefChip key={`${penRef.name ?? penRef.id}-${index}`} penRef={penRef} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function CodeCatalogSection({ pack }) {
  const inline = inlineCatalogComponents(pack);
  const rows = Object.entries(COMPONENT_CATALOG.components)
    .filter(([name, entry]) => entry.packs?.[pack] && !inline.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  if (!rows.length) return null;

  return (
    <section className="si-specimen-panel si-specimen-section">
      <p className="si-specimen-eyebrow">Code catalog</p>
      <ul className="si-specimen-catalog">
        {rows.map(([name, entry]) => (
          <li key={name}>
            <CatalogRow name={name} entry={entry} pack={pack} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SpecimenSection({ section, page }) {
  switch (section.type) {
    case 'colorSwatches':
      return (
        <section className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">{section.title}</p>
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
      );
    case 'labelSwatches':
      return (
        <section className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">{section.title}</p>
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
      );
    case 'typography':
      return (
        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">{section.title}</p>
          <p className="si-specimen-type-display">Display face</p>
          <p className="si-specimen-type-ui">UI label and controls</p>
          <p className="si-specimen-type-tertiary">Tertiary headers</p>
          <p className="si-specimen-type-body">Body copy for longer readable text.</p>
        </article>
      );
    case 'space':
      return (
        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">{section.title}</p>
          <div className="si-specimen-space-stack">
            {SPECIMEN_SPACES.map((space) => (
              <span className="si-specimen-space-item" key={space}>
                <span className="si-specimen-space-bar" style={{ width: `var(--si-space-${space})` }} />
                <code>{space}</code>
              </span>
            ))}
          </div>
        </article>
      );
    case 'radius':
      return (
        <article className="si-specimen-panel si-specimen-section">
          <p className="si-specimen-eyebrow">{section.title}</p>
          <div className="si-specimen-radius-grid">
            {SPECIMEN_RADII.map((radius) => (
              <span key={radius} style={{ borderRadius: `var(--si-radius-${radius})` }}>
                {radius}
              </span>
            ))}
          </div>
        </article>
      );
    case 'componentGroups': {
      const pack = section.groupPack ?? page.pack;
      const groups = COMPONENT_CATALOG.specimenGroups.filter((group) => group.pack === pack);
      return (
        <section className="si-specimen-panel si-specimen-section" data-si-surface="section">
          <p className="si-specimen-section-title">{section.title}</p>
          <div className="si-specimen-component-stack">
            {groups.map((group) => (
              <SpecimenGroupPanel key={group.id} group={group} pack={pack} />
            ))}
          </div>
        </section>
      );
    }
    case 'codeCatalog':
      return <CodeCatalogSection pack={section.groupPack ?? page.pack} />;
    default:
      return null;
  }
}
