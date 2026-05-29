import { useEffect, useMemo, useRef, useState } from 'react';

const SWIPE_DISMISS_DISTANCE_PX = 72;
const SWIPE_DISMISS_VELOCITY_PX_PER_MS = 0.55;

function formatDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function paragraphize(text) {
  if (!text) return [];
  return String(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function DetailLinks({ links = [], canonicalUrl }) {
  const detailLinks = [
    ...links,
    canonicalUrl ? { label: 'Canonical source', url: canonicalUrl } : null
  ].filter(Boolean);

  if (detailLinks.length === 0) return null;

  return (
    <div className="detail-sheet-links" aria-label="Detail links">
      {detailLinks.map((link) => (
        <a href={link.url} target="_blank" rel="noreferrer" key={`${link.label}-${link.url}`}>
          {link.label}
        </a>
      ))}
    </div>
  );
}

function ReleaseDetail({ item }) {
  const releaseDate = formatDate(item.releasedAt);

  return (
    <>
      <div className="detail-sheet-meta">
        {item.type ? <span>{item.type}</span> : null}
        {releaseDate ? <span>{releaseDate}</span> : null}
      </div>
      <p className="detail-sheet-summary">{item.summary}</p>
      {item.evidence ? (
        <section className="detail-sheet-section">
          <h3>Evidence</h3>
          <p>{item.evidence}</p>
        </section>
      ) : null}
      <DetailLinks links={item.links} />
    </>
  );
}

function ExperimentDetail({ item }) {
  return (
    <>
      <div className="detail-sheet-meta">
        {item.status ? <span>{item.status}</span> : null}
        {item.tag ? <span>{item.tag}</span> : null}
      </div>
      {item.summary ? <p className="detail-sheet-summary">{item.summary}</p> : null}
      {item.why ? (
        <section className="detail-sheet-section">
          <h3>Why</h3>
          {paragraphize(item.why).map((p) => <p key={p}>{p}</p>)}
        </section>
      ) : null}
      {item.successCriteria ? (
        <section className="detail-sheet-section">
          <h3>Success criteria</h3>
          {paragraphize(item.successCriteria).map((p) => <p key={p}>{p}</p>)}
        </section>
      ) : null}
      {item.currentLearning?.length > 0 ? (
        <section className="detail-sheet-section">
          <h3>Current learning</h3>
          {item.currentLearning.map((entry, i) => (
            <p key={i}>{typeof entry === 'string' ? entry : entry.note ?? JSON.stringify(entry)}</p>
          ))}
        </section>
      ) : null}
      <DetailLinks links={item.links} />
    </>
  );
}

function StoryDetail({ item }) {
  const publishedDate = formatDate(item.publishedAt);
  const draftedDate = formatDate(item.draftedAt);
  const bodyParagraphs = item.body && item.body !== item.dek ? paragraphize(item.body) : [];

  return (
    <>
      <div className="detail-sheet-meta">
        {item.source ? <span>{item.source.replaceAll('-', ' ')}</span> : null}
        {publishedDate ? <span>{publishedDate}</span> : draftedDate ? <span>Drafted {draftedDate}</span> : null}
      </div>
      {item.dek ? <p className="detail-sheet-summary">{item.dek}</p> : null}
      {bodyParagraphs.length > 0 ? (
        <section className="detail-sheet-section">
          <h3>Story</h3>
          {bodyParagraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </section>
      ) : null}
      {item.topics?.length ? (
        <div className="detail-sheet-topics" aria-label="Story topics">
          {item.topics.map((topic) => <span key={topic}>{topic}</span>)}
        </div>
      ) : null}
      <DetailLinks links={item.links} canonicalUrl={item.canonicalUrl} />
    </>
  );
}

export function DetailSheet({ item, type, onClose }) {
  const sheetRef = useRef(null);
  const touchStartRef = useRef(null);
  const [dragOffset, setDragOffset] = useState(0);

  const titleId = useMemo(() => (
    item ? `detail-sheet-title-${item.slug || item.title.replace(/\W+/g, '-').toLowerCase()}` : undefined
  ), [item]);

  useEffect(() => {
    if (!item) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.setTimeout(() => sheetRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [item, onClose]);

  if (!item) return null;

  const handleTouchStart = (event) => {
    const touch = event.touches[0];
    const atTop = !sheetRef.current || sheetRef.current.scrollTop === 0;
    touchStartRef.current = {
      y: touch.clientY,
      time: performance.now(),
      atTop,
    };
    setDragOffset(0);
  };

  const handleTouchMove = (event) => {
    if (!touchStartRef.current || !touchStartRef.current.atTop) return;
    const touch = event.touches[0];
    const offset = Math.max(0, touch.clientY - touchStartRef.current.y);
    setDragOffset(offset);
  };

  const handleTouchEnd = () => {
    if (!touchStartRef.current) return;
    const elapsed = Math.max(1, performance.now() - touchStartRef.current.time);
    const velocity = dragOffset / elapsed;
    touchStartRef.current = null;

    if (dragOffset >= SWIPE_DISMISS_DISTANCE_PX || velocity >= SWIPE_DISMISS_VELOCITY_PX_PER_MS) {
      onClose();
    }
    setDragOffset(0);
  };

  return (
    <div className="detail-sheet-layer" role="presentation">
      <button
        className="detail-sheet-backdrop"
        type="button"
        aria-label="Close detail"
        onClick={onClose}
      />
      <article
        className="detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={sheetRef}
        tabIndex={-1}
        style={{ '--detail-sheet-drag-offset': `${dragOffset}px` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="detail-sheet-handle" aria-hidden="true" />
        <button className="detail-sheet-close" type="button" aria-label="Close detail sheet" onClick={onClose}>
          ×
        </button>
        <p className="eyebrow">{type === 'release' ? 'Release detail' : type === 'experiment' ? 'Exploration detail' : 'Story detail'}</p>
        <h2 id={titleId}>{item.title}</h2>
        {type === 'release' ? <ReleaseDetail item={item} /> : type === 'experiment' ? <ExperimentDetail item={item} /> : <StoryDetail item={item} />}
      </article>
    </div>
  );
}
