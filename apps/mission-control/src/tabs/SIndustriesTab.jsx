import React, { useEffect, useRef, useState } from 'react';
import { Card } from '@sindustries/ui/react';

const SINDUSTRIES_URL = 'https://sindustries.co.nz';
// How long we wait for the iframe load event before showing the fallback.
// sindustries.co.nz is typically fast, but X-Frame-Options/CSP blocks
// never fire load events at all, so a timeout-based fallback is the
// only reliable detection in jsdom-free environments.
const IFRAME_LOAD_TIMEOUT_MS = 8000;

/**
 * SIndustriesTab embeds sindustries.co.nz as a Mission Control tab for
 * quick internal access alongside the existing tools. When embedding is
 * blocked by the upstream site's X-Frame-Options or CSP header (a real
 * possibility for marketing sites), the tab degrades gracefully to a
 * card with an external link that opens sindustries.co.nz in a new tab.
 *
 * The embedding contract is intentionally conservative: we never attempt
 * to bypass upstream framing headers, only detect the failure and
 * present the fallback path the AC explicitly allows.
 */
export function SIndustriesTab() {
  const [loadFailed, setLoadFailed] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    setLoadFailed(false);
    const timer = setTimeout(() => {
      // If onload hasn't fired by now the iframe is almost certainly
      // being blocked upstream. Switch to the fallback path.
      if (!loadedRef.current) {
        setLoadFailed(true);
      }
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleLoad = () => {
    loadedRef.current = true;
    setLoadFailed(false);
  };

  return (
    <section className="sindustries-tab" data-testid="pulse-sindustries">
      <header className="sindustries-tab__header">
        <h1 className="sindustries-tab__title">SIndustries</h1>
        <p className="sindustries-tab__subtitle">
          sindustries.co.nz embedded for quick access alongside internal tools.
        </p>
      </header>
      {loadFailed ? (
        <Card data-testid="pulse-sindustries-fallback">
          <h2 className="sindustries-tab__fallback-title">Embedding blocked</h2>
          <p className="sindustries-tab__fallback-detail">
            sindustries.co.nz refused to embed (likely{' '}
            <code>X-Frame-Options</code> or <code>CSP</code>). Open it in a new
            tab instead:
          </p>
          <a
            href={SINDUSTRIES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sindustries-tab__fallback-link"
            data-testid="pulse-sindustries-fallback-link"
          >
            {SINDUSTRIES_URL}
          </a>
        </Card>
      ) : (
        <iframe
          title="SIndustries"
          src={SINDUSTRIES_URL}
          onLoad={handleLoad}
          data-testid="pulse-sindustries-iframe"
          aria-label="SIndustries brand site"
          className="sindustries-tab__iframe"
        />
      )}
    </section>
  );
}