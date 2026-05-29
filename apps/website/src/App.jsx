import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DetailSheet } from './components/DetailSheet.jsx';
import { StickyCardStack } from './components/StickyCardStack.jsx';
import {
  experimentsContent,
  releasesContent,
  stacksContent,
  storiesContent,
  systemsContent
} from './content/index.js';

const SECTIONS = ['SIN', 'Signals', 'Systems', 'Stacks', 'Ships', 'Stories', 'Studio', 'Summon'];

const SOCIAL_LINKS = {
  x: 'https://x.com/stoff81?s=21&t=RdCkvkBscucBkM7Fx5wurg',
  tiktok: 'https://www.tiktok.com/@sindustries1?_r=1&_t=ZS-96GZycL6JzM'
};

const CONTACT_EMAIL = 'hello@sindustries.co.nz';

const published = (item) => item.visibility === 'published';

const SHIPS = releasesContent.filter(published);

const STORIES = storiesContent.filter(published);

const STUDIO = experimentsContent.filter(published).map((experiment) => ({
  name: experiment.title,
  tag: experiment.tag,
  image: experiment.image,
  body: experiment.summary,
  _source: experiment
}));

const SYSTEMS = systemsContent.filter(published).map((system) => ({
  name: system.title,
  tag: system.tag,
  image: system.image,
  body: system.summary
}));

const SIGNALS = [
  { label: 'active explorations', value: STUDIO.length, href: '#studio' },
  { label: 'systems at work', value: SYSTEMS.length, href: '#systems' },
  { label: 'released to the world', value: SHIPS.length, href: '#ships' },
  { label: 'builder logs', value: STORIES.length, href: '#stories' }
];

const STACKS = stacksContent.filter(published).map((stack) => stack.name);

const HEADER_TAB_TRIGGER_OFFSET_PX = 56;
const HEADER_TAB_TRANSITION_PX = 24;
const COLLAPSED_TAB_WIDTH_PX = 12;
/**
 * Sticky section title opacity: stay fully opaque until the section’s top is within
 * PAGE_HEADING_VISIBLE_PX of the viewport top, then fade over PAGE_HEADING_FADE_PX px.
 * Increase VISIBLE to delay the fade; increase FADE for a slower ramp.
 */
const PAGE_HEADING_VISIBLE_PX = 0;
const PAGE_HEADING_FADE_PX = 1;

function slug(label) {
  return label.toLowerCase();
}

function SectionNav({ current, tabProgress, tabRefs, tabsRef, headingTargets }) {
  const visibleIndex = Math.round(tabProgress);
  const activeIndex = SECTIONS.indexOf(current);

  return (
    <div className="section-nav-shell">
      {SECTIONS.slice(1).map((section) => (
        <span
          key={section}
          className="section-header-heading"
          style={{
            '--section-heading-target-x': `${headingTargets[section] ?? 0}px`,
            '--section-header-opacity': section === current ? 1 : 0
          }}
          aria-hidden="true"
        >
          {section}
        </span>
      ))}
      <nav className="section-nav" aria-label="Section navigation">
        <a href="#sin" className="section-logo" aria-label="SIndustries home">
          <LogoMark />
        </a>
        <div className="section-tabs" ref={tabsRef}>
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
                className={`section-tab ${expansion > 0.01 ? 'active' : 'collapsed'} ${index < activeIndex ? 'arrived' : ''}`}
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
  const [sectionState, setSectionState] = useState({
    activeSection: SECTIONS[0],
    tabProgress: 0,
    pageHeadingOpacities: {}
  });

  useEffect(() => {
    let animationFrame = null;

    const updateActiveSection = () => {
      const nav = document.querySelector('.section-nav-shell');
      const activationLine = nav?.getBoundingClientRect().bottom ?? 0;
      const tabTriggerLine = activationLine - HEADER_TAB_TRIGGER_OFFSET_PX;
      let activeIndex = 0;
      const sectionTops = SECTIONS.map((section) => {
        const element = document.getElementById(slug(section));
        return element ? element.getBoundingClientRect().top : Infinity;
      });

      for (let index = 0; index < sectionTops.length; index += 1) {
        if (sectionTops[index] <= tabTriggerLine + 1) activeIndex = index;
        else break;
      }

      const nextIndex = Math.min(activeIndex + 1, SECTIONS.length - 1);
      let tabProgress = activeIndex;

      if (nextIndex !== activeIndex) {
        const nextTop = sectionTops[nextIndex];
        const distanceToNext = nextTop - tabTriggerLine;
        const band = HEADER_TAB_TRANSITION_PX;
        let rawProgress;
        if (band <= 0) {
          rawProgress = distanceToNext <= 0 ? 1 : 0;
        } else {
          rawProgress = (band - distanceToNext) / band;
        }
        tabProgress = activeIndex + Math.min(1, Math.max(0, rawProgress));
      }

      const pageHeadingOpacities = Object.fromEntries(
        SECTIONS.slice(1).map((section) => {
          const top = sectionTops[SECTIONS.indexOf(section)];
          const fadeStart = PAGE_HEADING_VISIBLE_PX;
          let opacity;
          if (PAGE_HEADING_FADE_PX <= 0) {
            opacity = top >= fadeStart ? 1 : 0;
          } else {
            const fadeEnd = fadeStart - PAGE_HEADING_FADE_PX;
            if (top >= fadeStart) opacity = 1;
            else if (top <= fadeEnd) opacity = 0;
            else opacity = (top - fadeEnd) / PAGE_HEADING_FADE_PX;
          }

          return [section, opacity];
        })
      );

      setSectionState({ activeSection: SECTIONS[activeIndex], tabProgress, pageHeadingOpacities });
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

function Section({ name, eyebrow, title, subTitle, headingTarget, pageHeadingOpacity, children }) {
  return (
    <section
      id={slug(name)}
      className="home-section"
      style={{ '--section-heading-target-x': `${headingTarget ?? 0}px` }}
    >
      {name !== SECTIONS[0] ? (
        <div
          className="section-page-heading"
          style={{ '--section-page-heading-opacity': pageHeadingOpacity ?? 1 }}
          aria-hidden="true"
        >
          <span>{name}</span>
        </div>
      ) : null}
      <div className="section-inner">
        {eyebrow || title || subTitle ? (
          <div className="section-copy">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
            {subTitle ? <p className="section-subtitle">{subTitle}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

function useInViewOnce(threshold = 0.35) {
  const ref = useRef(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || isInView) return undefined;

    const reduceMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    if (reduceMotion || typeof IntersectionObserver !== 'function') {
      setIsInView(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { threshold }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isInView, threshold]);

  return [ref, isInView];
}

const FLIP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FLIP_NUMBERS = '0123456789';
const FLIP_SYMBOLS = '->';
const FLIP_STEP_MS = 64;
const FLIP_STAGGER_MS = 18;

function getFlipSequence(character) {
  const target = String(character).toUpperCase();
  if (target === ' ') return [' '];

  const alphabetIndex = FLIP_LETTERS.indexOf(target);
  if (alphabetIndex >= 0) return [' ', ...FLIP_LETTERS.slice(0, alphabetIndex + 1).split('')];

  const numberIndex = FLIP_NUMBERS.indexOf(target);
  if (numberIndex >= 0) return [' ', ...FLIP_NUMBERS.slice(0, numberIndex + 1).split('')];

  const symbolIndex = FLIP_SYMBOLS.indexOf(target);
  if (symbolIndex >= 0) return [' ', ...FLIP_SYMBOLS.slice(0, symbolIndex + 1).split('')];

  return [' ', target];
}

function useSplitFlapDisplay(text, active) {
  const targetText = String(text).toUpperCase();
  const [displayState, setDisplayState] = useState(() => (
    targetText.split('').map(() => ({ character: ' ', tick: 0 }))
  ));

  useEffect(() => {
    const reduceMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

    if (reduceMotion) {
      setDisplayState(targetText.split('').map((character) => ({ character, tick: 0 })));
      return undefined;
    }

    setDisplayState(targetText.split('').map(() => ({ character: ' ', tick: 0 })));
    if (!active) return undefined;

    const timers = [];
    targetText.split('').forEach((character, characterIndex) => {
      const sequence = getFlipSequence(character);
      sequence.forEach((nextCharacter, sequenceIndex) => {
        const timer = window.setTimeout(() => {
          setDisplayState((previous) => previous.map((item, itemIndex) => (
            itemIndex === characterIndex
              ? { character: nextCharacter, tick: item.tick + 1 }
              : item
          )));
        }, (sequenceIndex * FLIP_STEP_MS) + (characterIndex * FLIP_STAGGER_MS));
        timers.push(timer);
      });
    });

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [active, targetText]);

  return displayState;
}

function FlipText({ text, active }) {
  const characters = useSplitFlapDisplay(text, active);

  return (
    <span className="flip-text" aria-hidden="true">
      {characters.map(({ character, tick }, index) => (
        <span className={`flip-char ${character === ' ' ? 'space' : ''}`} key={index}>
          <span className="flip-char-value">{character === ' ' ? '\u00A0' : character}</span>
          <span className="flip-char-fold" key={`${index}-${tick}`} aria-hidden="true" />
        </span>
      ))}
    </span>
  );
}

function ScaleToFitWidth({ children }) {
  const frameRef = useRef(null);
  const contentRef = useRef(null);
  const [layout, setLayout] = useState({ scale: 1, height: undefined });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || typeof ResizeObserver === 'undefined') return undefined;

    const updateLayout = () => {
      const frameWidth = frame.clientWidth;
      const contentWidth = content.offsetWidth;
      const contentHeight = content.offsetHeight;
      if (!frameWidth || !contentWidth || !contentHeight) return;

      const scale = frameWidth / contentWidth;
      setLayout({ scale, height: contentHeight * scale });
    };

    updateLayout();
    const resizeObserver = new ResizeObserver(updateLayout);
    resizeObserver.observe(frame);
    resizeObserver.observe(content);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className="fit-scale-frame" ref={frameRef} style={layout.height ? { height: `${layout.height}px` } : undefined}>
      <div className="fit-scale-content" ref={contentRef} style={{ transform: `scale(${layout.scale})` }}>
        {children}
      </div>
    </div>
  );
}

function SignalClickerRow({ signal, index }) {
  const [ref, isInView] = useInViewOnce(0.45);
  const labelLength = Math.max(...SIGNALS.map(({ label }) => label.length));
  const numericLength = Math.max(...SIGNALS.map(({ value }) => `${value}->`.length));
  const numericLabel = `${signal.value}->`;
  const blankTilePadding = ' '.repeat(3);
  const rowText = `${signal.label.padEnd(labelLength, ' ')}${blankTilePadding}${numericLabel.padStart(numericLength, ' ')}`;

  return (
    <a
      ref={ref}
      className="signal-card"
      href={signal.href}
      style={{ '--signal-row-index': index }}
      aria-label={`${signal.label} ${signal.value} arrow`}
    >
      <span className="signal-line">
        <FlipText text={rowText} active={isInView} />
      </span>
    </a>
  );
}

function LogoMark() {
  return <img className="brand-logo" src="/brand/sindustries-logo.webp" alt="SIndustries" />;
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-grid">
        <a href="/about">About</a>
        <div className="footer-socials" aria-label="Social links">
          <a href={SOCIAL_LINKS.x} target="_blank" rel="noreferrer" aria-label="Follow Tom on X">𝕏</a>
          <a href={SOCIAL_LINKS.tiktok} target="_blank" rel="noreferrer" aria-label="Follow SIndustries on TikTok">♪</a>
        </div>
      </div>
    </footer>
  );
}

function AboutPage() {
  return (
    <>
    <div className="site-shell about-shell">
      <header className="about-hero">
        <a className="about-home-link" href="/" aria-label="Back to SIndustries home"><LogoMark /></a>
        <p className="eyebrow">About</p>
        <h1>Tom Stoffer builds systems for staying relevant.</h1>
        <p className="lede">
          SIndustries is Tom’s AI-native builder/operator company: part product studio, part operating system, part public lab for compounding leverage.
        </p>
      </header>

      <main className="about-content">
        <section className="about-card">
          <p className="eyebrow">Profile</p>
          <h2>Builder, engineering leader, systems thinker.</h2>
          <p>
            Tom Stoffer is a senior engineering leader based in Auckland, New Zealand. He has built software across games, DJ technology, surgical training, embedded platforms, web services, and agent systems.
          </p>
          <p>
            After years leading teams and shipping other people’s roadmaps, SIndustries is the vehicle for building his own IP in public: practical products, automation loops, AI-native workflows, and small explorations that can compound into a company of one.
          </p>
        </section>

        <section className="about-card dark">
          <p className="eyebrow">What SIndustries is for</p>
          <p>
            The thesis is simple: stay relevant in an ever-changing world by building systems that learn, products that test demand, and public signal that compounds over time.
          </p>
          <div className="about-actions">
            <a className="btn primary" href={SOCIAL_LINKS.x} target="_blank" rel="noreferrer">Follow on X</a>
            <a className="btn secondary" href={`mailto:${CONTACT_EMAIL}`}>Email Tom</a>
          </div>
        </section>
      </main>

    </div>
    <SiteFooter />
    </>
  );
}

export function App() {
  if (window.location.pathname === '/about') return <AboutPage />;

  const { activeSection, tabProgress, pageHeadingOpacities } = useSectionProgress();
  const tabRefs = useRef({});
  const tabsRef = useRef(null);
  const [navHeadingTargets, setNavHeadingTargets] = useState({});
  const [pageHeadingTargets, setPageHeadingTargets] = useState({});
  const [selectedDetail, setSelectedDetail] = useState(null);

  const closeDetail = useCallback(() => setSelectedDetail(null), []);

  useLayoutEffect(() => {
    const measureHeadingTargets = () => {
      const shell = document.querySelector('.section-nav-shell');
      const tabsEl = tabsRef.current;
      if (!shell || !tabsEl) return;

      const shellRect = shell.getBoundingClientRect();
      const tabsRect = tabsEl.getBoundingClientRect();
      const tabsLeftInShell = tabsRect.left - shellRect.left;

      const expandedWidth = Math.max(
        COLLAPSED_TAB_WIDTH_PX,
        tabsRect.width - ((SECTIONS.length - 1) * COLLAPSED_TAB_WIDTH_PX)
      );

      setNavHeadingTargets(
        Object.fromEntries(
          SECTIONS.map((section) => {
            const tabEl = tabRefs.current[section];
            if (!tabEl) return [section, 0];
            const r = tabEl.getBoundingClientRect();
            const cx = r.left + r.width / 2 - shellRect.left;
            return [section, cx];
          })
        )
      );

      setPageHeadingTargets(
        Object.fromEntries(
          SECTIONS.map((section, index) => [
            section,
            tabsLeftInShell + (index * COLLAPSED_TAB_WIDTH_PX) + (expandedWidth / 2)
          ])
        )
      );
    };

    measureHeadingTargets();
    window.addEventListener('resize', measureHeadingTargets);
    return () => window.removeEventListener('resize', measureHeadingTargets);
  }, [tabProgress, activeSection]);

  return (
    <>
    <div className="site-shell">
      <SectionNav
        current={activeSection}
        tabProgress={tabProgress}
        tabRefs={tabRefs}
        tabsRef={tabsRef}
        headingTargets={navHeadingTargets}
      />
      <main>
        <section id="sin" className="hero-section">
          <div className="hero-glow" aria-hidden="true" />
          <div className="hero-grid">
            <div className="hero-copy">
              <h1>Stay relevant in an ever-changing world</h1>
              <p className="lede">
                SINDUSTRIES is an AI-native builder/operator company: systems that compound, explorations that test reality, and signals that prove momentum.
              </p>
              <div className="hero-actions">
                <a className="btn primary" href={SOCIAL_LINKS.x} target="_blank" rel="noreferrer">Follow Tom on X</a>
                <a className="btn secondary" href="#signals">See the signal</a>
              </div>
            </div>
          </div>
        </section>

        <Section name="Signals" eyebrow="PROOF OF MOVEMENT" title="Systems, explorations and output signals" headingTarget={pageHeadingTargets.Signals} pageHeadingOpacity={pageHeadingOpacities.Signals}>
          <div className="signals-grid">
            <div className="signals-board">
              <ScaleToFitWidth>
                <div className="signals-flap-panel">
                  {SIGNALS.map((signal, index) => (
                    <SignalClickerRow signal={signal} index={index} key={signal.label} />
                  ))}
                </div>
              </ScaleToFitWidth>
            </div>
          </div>
        </Section>

        <Section name="Systems" headingTarget={pageHeadingTargets.Systems} pageHeadingOpacity={pageHeadingOpacities.Systems}>
          <StickyCardStack items={SYSTEMS} eyebrow="Repeatable engines" title="Compounding value over time" />
        </Section>

        <Section name="Stacks" eyebrow="Operating Infrastructure" title="The tools that keep us sharp" headingTarget={pageHeadingTargets.Stacks} pageHeadingOpacity={pageHeadingOpacities.Stacks}>
          <div className="stack-marquee" aria-label="SIndustries technology stack">
            {[0, 1, 2].map((row) => (
              <div className="stack-marquee-row" key={row} style={{ '--stack-row-index': row }}>
                <div className="stack-marquee-track">
                  {[0, 1].map((set) => (
                    <div className="stack-marquee-set" key={set} aria-hidden={set === 1 ? 'true' : undefined}>
                      {STACKS.map((stack) => (
                        <span key={`${set}-${stack}`}>{stack}</span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Ships" eyebrow="Released to the world" title="Outputs that have left the dock" headingTarget={pageHeadingTargets.Ships} pageHeadingOpacity={pageHeadingOpacities.Ships}>
          <div className="ships-list">
            {SHIPS.map((ship, index) => (
              <button
                className="ship-row"
                type="button"
                key={ship.slug}
                onClick={() => setSelectedDetail({ type: 'release', item: ship })}
                aria-label={`Open release detail for ${ship.title}`}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{ship.title}</p>
              </button>
            ))}
          </div>
        </Section>

        <Section name="Stories" eyebrow="Founder log" title="Notes from the edge of the build." headingTarget={pageHeadingTargets.Stories} pageHeadingOpacity={pageHeadingOpacities.Stories}>
          <div className="stories-grid">
            {STORIES.map((story) => (
              <button
                className="story-card"
                type="button"
                key={story.slug}
                onClick={() => setSelectedDetail({ type: 'story', item: story })}
                aria-label={`Open story detail for ${story.title}`}
              >
                <p className="story-source">From X</p>
                <h3>{story.title}</h3>
                <p>{story.dek}</p>
                <span className="story-link">Read detail</span>
              </button>
            ))}
          </div>
        </Section>

        <Section name="Studio" headingTarget={pageHeadingTargets.Studio} pageHeadingOpacity={pageHeadingOpacities.Studio}>
          <StickyCardStack
            items={STUDIO}
            eyebrow="Explorations"
            title="Proof before scale"
            onCardClick={(item) => setSelectedDetail({ type: 'experiment', item: item._source })}
          />
        </Section>

        <Section name="Summon" eyebrow="Open Line" title="Follow the signal" headingTarget={pageHeadingTargets.Summon} pageHeadingOpacity={pageHeadingOpacities.Summon}>
          <div className="summon-grid">
            <p className="lede">
              If you are building, backing, or reshaping how organisations work, the line is open. Follow the systems, watch the explorations, or start a conversation.
            </p>
            <div className="summon-actions">
              <a className="btn primary" href={`mailto:${CONTACT_EMAIL}`}>Email Tom</a>
              <a className="btn secondary light" href={SOCIAL_LINKS.x} target="_blank" rel="noreferrer">X</a>
              <a className="btn secondary light" href={SOCIAL_LINKS.tiktok} target="_blank" rel="noreferrer">TikTok</a>
            </div>
          </div>
        </Section>

      </main>
    </div>
    <DetailSheet
      type={selectedDetail?.type}
      item={selectedDetail?.item}
      onClose={closeDetail}
    />
    <SiteFooter />
    </>
  );
}
