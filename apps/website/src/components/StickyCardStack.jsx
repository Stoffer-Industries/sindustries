import { ScrollLinkedCardStack } from './scroll-linked-card-stack/index.js';

export function StickyCardStack({ items, eyebrow, title, subTitle }) {
  return (
    <ScrollLinkedCardStack
      className="si-sticky-card-stack"
      items={items}
      stickyTop={{ desktop: 78, mobile: 70 }}
      stackOffset={{ desktop: 18, mobile: 34 }}
      enterOffset={{ desktop: 620, mobile: 430 }}
      revealDistance={{ desktop: 460, mobile: 420 }}
      endBuffer={{ desktop: 280, mobile: 220 }}
      cardMinHeight="clamp(240px, 34vh, 340px)"
      headerMinHeight="clamp(110px, 14vw, 180px)"
      getKey={(item) => item.name}
      renderHeader={() => (
        <div className="section-copy sticky-cards-copy">
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          {subTitle ? <p className="section-subtitle">{subTitle}</p> : null}
        </div>
      )}
      renderCard={(item) => (
        <>
          <div
            className={`sticky-card-visual ${item.image ? 'has-image' : ''}`}
            aria-hidden="true"
            style={item.image ? { '--sticky-card-image': `url(${item.image})` } : undefined}
          />
          <div className="sticky-card-copy">
            <p className="sticky-card-tag">{item.tag}</p>
            <h3>{item.name}</h3>
            <p>{item.body}</p>
          </div>
        </>
      )}
    />
  );
}
