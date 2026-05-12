import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const SECTIONS = ['SIN', 'Signals', 'Systems', 'Stacks', 'Ships', 'Stories', 'Studio', 'Summon'];

const SOCIAL_LINKS = {
  x: 'https://x.com/stoff81?s=21&t=RdCkvkBscucBkM7Fx5wurg',
  tiktok: 'https://www.tiktok.com/@sindustries1?_r=1&_t=ZS-96GZycL6JzM'
};

const CONTACT_EMAIL = 'hello@sindustries.co.nz';

const SIGNALS = [
  { label: 'commits', value: '1,247', note: 'last 90 days' },
  { label: 'projects', value: '08', note: 'active threads' },
  { label: 'systems', value: '04', note: 'online / forming' },
  { label: 'ships', value: '23', note: 'released or merged' }
];

const SYSTEMS = [
  {
    name: 'OpenClaw',
    tag: 'Chief-of-staff OS',
    body: 'Agent orchestration, memory, tasks, and the operating layer around Tom’s work.'
  },
  {
    name: 'Agent Ops',
    tag: 'Quinn / Rowan / Lox',
    body: 'Specialist agents with roles, workflows, reviews, and delivery discipline.'
  },
  {
    name: 'Software Factory',
    tag: 'Shape → build → review',
    body: 'A repeatable loop for turning loose intent into executable, reviewed work.'
  },
  {
    name: 'Commerce Loops',
    tag: 'Drops / tests / learning',
    body: 'Lightweight experiments for products, waitlists, content, and revenue signals.'
  }
];

const STACKS = ['OpenClaw', 'Plano', 'Local models', 'Codex', 'MiniMax', 'Telegram', 'Tasks API', 'Vite', 'React'];

const SHIPS = [
  'SIndustries website v1',
  'Tasks API prodlike workflow',
  'Agent role split: Quinn / Rowan / Lox',
  'Plano local model routing',
  'Drop microsite prototype'
];

const STORIES = [
  'The company-of-one operating system.',
  'Turning an assistant into a chief of staff.',
  'Building in public before the business is obvious.'
];

const STUDIO = ['Live signal feed', 'Agent workbench', 'First product drop', 'Founder log stream'];
const HEADER_TAB_TRANSITION_PX = 20;

function slug(label) {
  return label.toLowerCase();
}

function SectionNav({ current, tabProgress, tabRefs }) {
  const visibleIndex = Math.round(tabProgress);

  return (
    <div className="section-nav-shell">
      <nav className="section-nav" aria-label="Section navigation">
        <a href="#sin" className="section-logo" aria-label="SIndustries home">
          <LogoMark />
        </a>
        <div className="section-tabs">
          {SECTIONS.map((section, index) => {
            const distance = Math.abs(index - tabProgress);
            const expansion = Math.max(0, 1 - distance);
            const isVisible = index === visibleIndex;

            return (
              <a
                key={section}
                ref={(element) => {
                  tabRefs.current[section] = element;
                }}
                href={`#${slug(section)}`}
                className={`section-tab ${expansion > 0.01 ? 'active' : 'collapsed'}`}
                style={{ '--tab-expansion': expansion }}
                aria-current={section === current ? 'page' : undefined}
                aria-label={isVisible ? section : `Go to ${section}`}
              >
                <span>{section}</span>
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function useSectionProgress() {
  const [sectionState, setSectionState] = useState({ activeSection: SECTIONS[0], tabProgress: 0 });

  useEffect(() => {
    let animationFrame = null;

    const updateActiveSection = () => {
      const nav = document.querySelector('.section-nav-shell');
      const activationLine = nav?.getBoundingClientRect().bottom ?? 0;
      let activeIndex = 0;
      const sectionTops = SECTIONS.map((section) => {
        const element = document.getElementById(slug(section));
        return element ? element.getBoundingClientRect().top : Infinity;
      });

      for (let index = 0; index < sectionTops.length; index += 1) {
        if (sectionTops[index] <= activationLine + 1) activeIndex = index;
        else break;
      }

      const nextIndex = Math.min(activeIndex + 1, SECTIONS.length - 1);
      let tabProgress = activeIndex;

      if (nextIndex !== activeIndex) {
        const nextTop = sectionTops[nextIndex];
        const distanceToNext = nextTop - activationLine;
        const rawProgress = (HEADER_TAB_TRANSITION_PX - distanceToNext) / HEADER_TAB_TRANSITION_PX;
        tabProgress = activeIndex + Math.min(1, Math.max(0, rawProgress));
      }

      setSectionState({ activeSection: SECTIONS[activeIndex], tabProgress });
    };

    const requestUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updateActiveSection();
      });
    };

    updateActiveSection();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
    };
  }, []);

  return sectionState;
}

function Section({ name, eyebrow, title, headingTarget, children }) {
  return (
    <section
      id={slug(name)}
      className="home-section"
      style={{ '--section-heading-target-x': `${headingTarget ?? 0}px` }}
    >
      {name !== SECTIONS[0] ? (
        <div className="section-page-heading" aria-hidden="true">
          <span>{name}</span>
        </div>
      ) : null}
      <div className="section-inner">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}

function LogoMark() {
  return <img className="brand-logo" src="/brand/sindustries-logo.webp" alt="SIndustries" />;
}

export function App() {
  const { activeSection, tabProgress } = useSectionProgress();
  const tabRefs = useRef({});
  const [headingTargets, setHeadingTargets] = useState({});

  useLayoutEffect(() => {
    const measureHeadingTargets = () => {
      setHeadingTargets(Object.fromEntries(
        SECTIONS.map((section) => {
          const tabRect = tabRefs.current[section]?.getBoundingClientRect();
          return [section, tabRect ? tabRect.left + tabRect.width / 2 : 0];
        })
      ));
    };

    measureHeadingTargets();
    window.addEventListener('resize', measureHeadingTargets);
    return () => window.removeEventListener('resize', measureHeadingTargets);
  }, [tabProgress]);

  return (
    <div className="site-shell">
      <SectionNav
        current={activeSection}
        tabProgress={tabProgress}
        tabRefs={tabRefs}
      />
      <main>
        <section id="sin" className="hero-section">
          <div className="hero-glow" aria-hidden="true" />
          <div className="hero-grid">
            <div className="hero-copy">
              <a className="hero-brand" href="#sin" aria-label="SIndustries home">
                <LogoMark />
              </a>
              <p className="status-line"><span /> SIndustries is online</p>
              <h1>Build the systems. Ship the signal.</h1>
              <p className="lede">
                SIndustries is Tom Stoffer’s AI-native builder/operator company: tools, agents, workflows, and experiments that turn uncertainty into useful action.
              </p>
              <div className="hero-actions">
                <a className="btn primary" href={SOCIAL_LINKS.x}>Follow Tom on X</a>
                <a className="btn secondary" href="#signals">See the signal</a>
              </div>
            </div>

            <aside className="live-card" aria-label="Current activity">
              <div className="live-card-header">
                <p>Live board</p>
                <span>Active</span>
              </div>
              {['agent workflow', 'homepage iteration', 'first drop', 'infra review'].map((item) => (
                <div className="live-row" key={item}>
                  <span>{item}</span>
                  <i aria-hidden="true" />
                </div>
              ))}
            </aside>
          </div>
        </section>

        <Section name="Signals" eyebrow="Live-ish proof" title="Numbers that make the work feel alive." headingTarget={headingTargets.Signals}>
          <div className="signals-grid">
            {SIGNALS.map((signal) => (
              <article className="signal-card" key={signal.label}>
                <p>{signal.label}</p>
                <strong>{signal.value}</strong>
                <span>{signal.note}</span>
              </article>
            ))}
          </div>
        </Section>

        <Section name="Systems" eyebrow="What we are building" title="Hero cards for the machines in motion." headingTarget={headingTargets.Systems}>
          <div className="systems-grid">
            {SYSTEMS.map((system) => (
              <article className="system-card" key={system.name}>
                <div className="system-visual" aria-hidden="true" />
                <p className="system-tag">{system.tag}</p>
                <h3>{system.name}</h3>
                <p>{system.body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section name="Stacks" eyebrow="Operating model" title="The tools behind the output." headingTarget={headingTargets.Stacks}>
          <div className="stack-cloud">
            {STACKS.map((stack) => <span key={stack}>{stack}</span>)}
          </div>
        </Section>

        <Section name="Ships" eyebrow="Changelog" title="Things that have left the dock." headingTarget={headingTargets.Ships}>
          <div className="ships-list">
            {SHIPS.map((ship, index) => (
              <article className="ship-row" key={ship}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{ship}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section name="Stories" eyebrow="Founder log" title="Notes from the edge of the build." headingTarget={headingTargets.Stories}>
          <div className="stories-grid">
            {STORIES.map((story) => (
              <article className="story-card" key={story}>
                <h3>{story}</h3>
                <p>Placeholder — draft story slot.</p>
              </article>
            ))}
          </div>
        </Section>

        <Section name="Studio" eyebrow="Experiments" title="Prototypes, sparks, and unfinished machines." headingTarget={headingTargets.Studio}>
          <div className="studio-grid">
            {STUDIO.map((item) => (
              <article className="studio-card" key={item}>
                <span aria-hidden="true" />
                <h3>{item}</h3>
                <p>In the lab.</p>
              </article>
            ))}
          </div>
        </Section>

        <Section name="Summon" eyebrow="Call to action" title="Follow the signal. Open the line." headingTarget={headingTargets.Summon}>
          <div className="summon-grid">
            <p className="lede">
              If you are building, backing, or reshaping how organisations work, the line is open. Follow the experiments or start a conversation.
            </p>
            <div className="summon-actions">
              <a className="btn primary" href={`mailto:${CONTACT_EMAIL}`}>Email Tom</a>
              <a className="btn secondary light" href={SOCIAL_LINKS.x}>X</a>
              <a className="btn secondary light" href={SOCIAL_LINKS.tiktok}>TikTok</a>
            </div>
          </div>
        </Section>
      </main>

      <footer className="footer" id="about">
        <div>
          <LogoMark />
          <p>
            About: SIndustries builds practical digital products, agent systems, and operating loops in public from Auckland, New Zealand.
          </p>
          <p>Contact: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
        </div>
        <div className="footer-links">
          <a href={SOCIAL_LINKS.x}>X</a>
          <a href={SOCIAL_LINKS.tiktok}>TikTok</a>
        </div>
      </footer>
    </div>
  );
}
