import React, { useEffect, useRef, useState } from 'react';
import { sankey as d3Sankey, sankeyLinkHorizontal, sankeyLeft } from 'd3-sankey';
import { STATUS_COLOR_VAR } from '../bookmarkPipeline.js';

const SANKEY_HEIGHT = 300;
const SANKEY_PADDING = { top: 20, right: 168, bottom: 20, left: 10 };

export function BookmarksSankeyChart({ sankey }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth || 800;
      setWidth(Math.max(360, w));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener('resize', measure);
      return () => {
        ro.disconnect();
        window.removeEventListener('resize', measure);
      };
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  if (!sankey || !sankey.nodes.length) {
    return (
      <div
        ref={containerRef}
        className="bookmarks-tab__sankey-wrap"
        data-testid="pulse-bookmarks-sankey-empty"
      >
        Not enough data to render.
      </div>
    );
  }

  const innerWidth = Math.max(1, width - SANKEY_PADDING.left - SANKEY_PADDING.right);
  const innerHeight = SANKEY_HEIGHT - SANKEY_PADDING.top - SANKEY_PADDING.bottom;
  const layout = d3Sankey()
    .nodeWidth(18)
    .nodePadding(22)
    .extent([
      [SANKEY_PADDING.left, SANKEY_PADDING.top],
      [SANKEY_PADDING.left + innerWidth, SANKEY_PADDING.top + innerHeight]
    ])
    .nodeAlign(sankeyLeft);

  // d3-sankey mutates its input nodes, so we deep-clone before layout
  // to keep the data source stable for subsequent renders.
  const inputNodes = sankey.nodes.map((n) => ({ ...n }));
  const inputLinks = sankey.links.map((l) => ({ ...l }));
  const { nodes, links } = layout({
    nodes: inputNodes,
    links: inputLinks.map((l, i) => ({
      ...l,
      source: typeof l.source === 'object' ? sankey.nodes.indexOf(l.source) : i,
      target: typeof l.target === 'object' ? sankey.nodes.indexOf(l.target) : i
    }))
  });

  return (
    <div
      ref={containerRef}
      className="bookmarks-tab__sankey-wrap"
      data-testid="pulse-bookmarks-sankey-chart"
    >
      <svg
        role="presentation"
        aria-hidden="true"
        viewBox={`0 0 ${width} ${SANKEY_HEIGHT}`}
        width={width}
        height={SANKEY_HEIGHT}
      >
        <defs>
          {links.map((link, i) => (
            <linearGradient
              key={i}
              id={`sankey-grad-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={link.source.x1}
              x2={link.target.x0}
            >
              <stop offset="0%" stopColor={link.source.color} />
              <stop offset="100%" stopColor={link.target.color} />
            </linearGradient>
          ))}
        </defs>
        <g>
          {links.map((link, i) => (
            <path
              key={i}
              d={sankeyLinkHorizontal()(link)}
              fill="none"
              stroke={`url(#sankey-grad-${i})`}
              strokeOpacity={0.25}
              strokeWidth={Math.max(1, link.width)}
              data-testid={`pulse-bookmarks-sankey-link-${link.source.name}-${link.target.name}`}
            >
              <title>{`${link.source.name} → ${link.target.name}: ${link.value}`}</title>
            </path>
          ))}
        </g>
        <g>
          {nodes.map((node) => (
            <g key={node.name}>
              <rect
                x={node.x0}
                y={node.y0}
                width={node.x1 - node.x0}
                height={Math.max(1, node.y1 - node.y0)}
                fill={node.color}
                rx={3}
                data-testid={`pulse-bookmarks-sankey-node-${node.name}`}
              />
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 - 10}
                dy="0.35em"
                textAnchor="start"
                fontSize={12}
                fontWeight={700}
                fill="var(--si-color-text, #111)"
              >
                {node.name}
              </text>
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 + 2}
                dy="0.35em"
                textAnchor="start"
                fontSize={10}
                fill="var(--si-color-text-muted, #6f819b)"
              >
                {`${node.count} items`}
              </text>
              <text
                x={node.x1 + 8}
                y={(node.y0 + node.y1) / 2 + 14}
                dy="0.35em"
                textAnchor="start"
                fontSize={10}
                fill="var(--si-color-text-muted, #9aaabb)"
              >
                {(() => {
                  const inFlow = node.targetLinks.reduce((s, l) => s + l.value, 0);
                  const outFlow = node.sourceLinks.reduce((s, l) => s + l.value, 0);
                  if (!inFlow) return `out: ${outFlow}`;
                  if (!outFlow) return `in: ${inFlow}`;
                  return `in: ${inFlow}  out: ${outFlow}`;
                })()}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
