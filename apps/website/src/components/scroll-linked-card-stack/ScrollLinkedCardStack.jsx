import { memo, useEffect, useRef, useState } from 'react';
import './ScrollLinkedCardStack.css';

const responsiveValue = (value, isMobile) => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') return isMobile ? value.mobile : value.desktop;
  return 0;
};

function ScrollLinkedCardStackComponent({
  items,
  renderHeader,
  renderCard,
  getKey = (item, index) => item?.id ?? item?.name ?? index,
  className = '',
  breakpoint = 720,
  stickyTop = { desktop: 78, mobile: 70 },
  stackOffset = { desktop: 18, mobile: 34 },
  enterOffset = { desktop: 620, mobile: 430 },
  revealDistance = { desktop: 460, mobile: 420 },
  endBuffer = { desktop: 280, mobile: 220 },
  cardMinHeight = 'clamp(300px, 44vh, 460px)',
  headerMinHeight = 'clamp(110px, 14vw, 180px)'
}) {
  const rootRef = useRef(null);
  const headerRef = useRef(null);
  const stageRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 1024, height: 768 });
  const [headerHeight, setHeaderHeight] = useState(0);
  const isMobile = viewport.width <= breakpoint;
  const resolvedStickyTop = responsiveValue(stickyTop, isMobile);
  const resolvedStackOffset = responsiveValue(stackOffset, isMobile);
  const configuredEnterOffset = responsiveValue(enterOffset, isMobile);
  const resolvedEnterOffset = Math.max(configuredEnterOffset, viewport.height - resolvedStickyTop + resolvedStackOffset);
  const resolvedRevealDistance = responsiveValue(revealDistance, isMobile);
  const resolvedEndBuffer = responsiveValue(endBuffer, isMobile);

  useEffect(() => {
    const updateMeasurements = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setHeaderHeight(Math.ceil(headerRef.current?.getBoundingClientRect().height ?? 0));
    };
    updateMeasurements();
    window.addEventListener('resize', updateMeasurements);
    return () => window.removeEventListener('resize', updateMeasurements);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage) return undefined;

    const cards = Array.from(stage.querySelectorAll('.slcs-card'));
    let animationFrame = null;
    let startY = 0;
    let lastPositions = [];

    const measure = () => {
      const rect = root.getBoundingClientRect();
      startY = window.scrollY + rect.top - resolvedStickyTop;
      lastPositions = [];
      requestUpdate();
    };

    const cardY = (index, distance) => {
      if (index === 0) return 0;
      const start = (index - 1) * resolvedRevealDistance;
      const progress = Math.max(0, Math.min(1, (distance - start) / resolvedRevealDistance));
      return Math.round((index * resolvedStackOffset) + (resolvedEnterOffset * (1 - progress)));
    };

    const update = () => {
      animationFrame = null;
      const maxDistance = ((items.length - 2) * resolvedRevealDistance) + resolvedRevealDistance + resolvedEndBuffer;
      const distance = Math.max(0, Math.min(window.scrollY - startY, maxDistance));

      cards.forEach((card, index) => {
        const y = cardY(index, distance);
        if (lastPositions[index] === y) return;
        lastPositions[index] = y;
        card.style.transform = `translate3d(0, ${y}px, 0)`;
        card.style.opacity = '1';
      });
    };

    function requestUpdate() {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(update);
    }

    measure();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [items.length, resolvedEndBuffer, resolvedEnterOffset, resolvedRevealDistance, resolvedStackOffset, resolvedStickyTop]);

  return (
    <div
      className={`slcs-root ${className}`.trim()}
      ref={rootRef}
      style={{
        '--slcs-stack-offset': `${resolvedStackOffset}px`,
        '--slcs-enter-offset': `${resolvedEnterOffset}px`,
        '--slcs-reveal-distance': `${resolvedRevealDistance}px`,
        '--slcs-end-buffer': `${resolvedEndBuffer}px`,
        '--slcs-card-count': items.length,
        '--slcs-header-height': `${headerHeight}px`,
        '--slcs-sticky-top': `${resolvedStickyTop}px`,
        '--slcs-card-min-height': cardMinHeight,
        '--slcs-header-min-height': headerMinHeight
      }}
    >
      <div className="slcs-scene">
        <div className="slcs-header" ref={headerRef}>
          {renderHeader?.()}
        </div>
        <div className="slcs-stage" ref={stageRef}>
          {items.map((item, index) => (
            <article
              className="slcs-card"
              key={getKey(item, index)}
              style={{
                '--slcs-card-index': index,
                transform: `translate3d(0, ${index === 0 ? 0 : (index * resolvedStackOffset) + resolvedEnterOffset}px, 0)`,
                opacity: 1
              }}
            >
              {renderCard(item, index)}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

export const ScrollLinkedCardStack = memo(ScrollLinkedCardStackComponent);
