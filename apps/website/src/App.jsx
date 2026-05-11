import { useEffect, useMemo, useState } from 'react';

const NAV_ITEMS = [
  { label: 'Home', path: '/' },
  { label: 'About', path: '/about' },
  { label: 'Contact', path: '/contact' }
];

const SOCIAL_LINKS = {
  x: 'https://x.com/stoff81?s=21&t=RdCkvkBscucBkM7Fx5wurg',
  tiktok: 'https://www.tiktok.com/@sindustries1?_r=1&_t=ZS-96GZycL6JzM'
};

const CONTACT_EMAIL = 'hello@sindustries.co.nz';

const SITE_COPY = {
  heroTitle: 'Stay relevant in an ever-changing world.',
  heroBody:
    'SIndustries is Tom Stoffer\'s AI-native business for building in public: testing tools, systems, and experiments that turn uncertainty into useful action.',
  positioning:
    'We are not pretending anyone has the full map. We are building from real software delivery experience, using the latest tools, and sharing what actually creates value.',
  principles: [
    'Face reality early.',
    'Build for outcomes, not activity.',
    'Stay fit as the world changes.',
    'Think in systems, not symptoms.',
    'Move with intent.',
    'Bring people with you.'
  ],
  experiments: [
    'OpenClaw and AI chief-of-staff systems',
    'Ecommerce drops and lightweight commerce loops',
    'Software factory workflows for shaping and shipping work',
    'Content factory systems for turning work into public signal',
    'Personal finance and fitness assistant experiments'
  ],
  aboutBody:
    'SIndustries is the place Tom builds, tests, and shares what comes next. It combines deep software delivery experience with AI-native tools to explore new ways of working, building, and staying relevant.',
  contactBody:
    'If you are building, backing, or reshaping how organisations work, the line is open.'
};

function getPathname() {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname || '/';
}

function usePathname() {
  const [pathname, setPathname] = useState(getPathname());

  useEffect(() => {
    function handlePopState() {
      setPathname(getPathname());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function navigate(path) {
    if (path === pathname) return;
    window.history.pushState({}, '', path);
    setPathname(path);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  return { pathname, navigate };
}

function Shell({ pathname, navigate, children }) {
  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => {
          event.preventDefault();
          navigate('/');
        }}>
          <img className="brand-logo" src="/brand/sindustries-logo.webp" alt="SIndustries" />
        </a>
        <nav className="nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={pathname === item.path ? 'nav-link active' : 'nav-link'}
              onClick={(event) => {
                event.preventDefault();
                navigate(item.path);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="footer">
        <p>SIndustries · Auckland, New Zealand</p>
        <div className="footer-links">
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          <a href={SOCIAL_LINKS.x}>X</a>
          <a href={SOCIAL_LINKS.tiktok}>TikTok</a>
        </div>
      </footer>
    </div>
  );
}

function HomePage({ navigate }) {
  return (
    <>
      <section className="hero panel dark-panel">
        <p className="eyebrow">AI-native build in public</p>
        <h1>{SITE_COPY.heroTitle}</h1>
        <p className="lede">{SITE_COPY.heroBody}</p>
        <div className="hero-actions">
          <a className="btn primary" href={SOCIAL_LINKS.x}>Follow Tom on X</a>
          <a className="btn secondary" href={SOCIAL_LINKS.tiktok}>Follow the story</a>
          <button className="btn ghost" onClick={() => navigate('/about')}>What we are building</button>
        </div>
      </section>

      <section className="grid two-up">
        <article className="panel">
          <p className="eyebrow">What SIndustries is</p>
          <h2>Figuring out what comes next by building it.</h2>
          <p>{SITE_COPY.positioning}</p>
        </article>
        <article className="panel dark-panel">
          <p className="eyebrow">Current experiments</p>
          <ul>
            {SITE_COPY.experiments.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel values-panel">
        <p className="eyebrow">How we work</p>
        <h2>Curious, direct, outcome-led.</h2>
        <div className="principles-grid">
          {SITE_COPY.principles.map((principle) => (
            <article key={principle} className="principle-card">
              <span className="principle-marker" aria-hidden="true">▸</span>
              <p>{principle}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function AboutPage() {
  return (
    <section className="page-stack">
      <div className="panel page-intro">
        <p className="eyebrow">About</p>
        <h1>A business for building what comes next.</h1>
        <p className="lede">{SITE_COPY.aboutBody}</p>
      </div>
      <div className="grid two-up">
        <article className="panel dark-panel">
          <p className="eyebrow">Why it exists</p>
          <p>
            The AI wave is changing how software, teams, and companies are built. SIndustries exists
            to test those changes in the open and find what creates real value.
          </p>
        </article>
        <article className="panel">
          <p className="eyebrow">The stance</p>
          <p>
            No one knows exactly how this plays out. The work is to stay close to reality, build in
            small useful slices, and keep adapting as the signal gets clearer.
          </p>
        </article>
      </div>
      <article className="panel founder-note">
        <p className="eyebrow">Founder profile</p>
        <h2>Tom Stoffer</h2>
        <p>
          Tom is a builder/operator with a background in software, product delivery, and scaling
          teams. He has helped take multiple companies to exit across a broad spectrum of industries.
          SIndustries is where he builds in public and explores what AI-native work makes possible.
        </p>
      </article>
    </section>
  );
}

function ContactPage() {
  return (
    <section className="page-stack">
      <div className="panel page-intro dark-panel">
        <p className="eyebrow">Contact</p>
        <h1>Open line. Clear signal.</h1>
        <p className="lede">{SITE_COPY.contactBody}</p>
      </div>
      <div className="grid two-up">
        <article className="panel">
          <p className="eyebrow">Email</p>
          <a className="contact-link" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          <p className="muted">Best for collaborations, intros, and serious product conversations.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Follow along</p>
          <ul className="link-list">
            <li><a href={SOCIAL_LINKS.x}>Follow Tom on X</a></li>
            <li><a href={SOCIAL_LINKS.tiktok}>Follow the story on TikTok</a></li>
          </ul>
        </article>
      </div>
    </section>
  );
}

export function App() {
  const { pathname, navigate } = usePathname();

  const page = useMemo(() => {
    if (pathname === '/about') return <AboutPage />;
    if (pathname === '/contact') return <ContactPage />;
    return <HomePage navigate={navigate} />;
  }, [navigate, pathname]);

  return <Shell pathname={pathname} navigate={navigate}>{page}</Shell>;
}
