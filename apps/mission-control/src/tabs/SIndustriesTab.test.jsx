import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { SIndustriesTab } from './SIndustriesTab.jsx';

const SINDUSTRIES_URL = 'https://sindustries.co.nz';
const IFRAME_LOAD_TIMEOUT_MS = 8000;

describe('SIndustriesTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the iframe with correct title, src, and aria-label', () => {
    render(<SIndustriesTab />);
    const iframe = screen.getByTestId('pulse-sindustries-iframe');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe.getAttribute('title')).toBe('SIndustries');
    expect(iframe.getAttribute('src')).toBe(SINDUSTRIES_URL);
    expect(iframe.getAttribute('aria-label')).toBe('SIndustries brand site');
    expect(screen.queryByTestId('pulse-sindustries-fallback')).toBeNull();
  });

  it('shows the fallback card after the iframe load timeout fires', () => {
    render(<SIndustriesTab />);
    expect(screen.getByTestId('pulse-sindustries-iframe')).toBeTruthy();
    expect(screen.queryByTestId('pulse-sindustries-fallback')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(IFRAME_LOAD_TIMEOUT_MS);
    });

    expect(screen.queryByTestId('pulse-sindustries-iframe')).toBeNull();
    const fallback = screen.getByTestId('pulse-sindustries-fallback');
    expect(fallback).toBeTruthy();
    const link = screen.getByTestId('pulse-sindustries-fallback-link');
    expect(link.getAttribute('href')).toBe(SINDUSTRIES_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('does not show the fallback before the timeout fires', () => {
    render(<SIndustriesTab />);
    act(() => {
      vi.advanceTimersByTime(IFRAME_LOAD_TIMEOUT_MS - 100);
    });
    expect(screen.getByTestId('pulse-sindustries-iframe')).toBeTruthy();
    expect(screen.queryByTestId('pulse-sindustries-fallback')).toBeNull();
  });

  it('clears the fallback once the iframe load event fires before the timeout', () => {
    render(<SIndustriesTab />);

    // Simulate the upstream site firing its load event (succeeds).
    const iframe = screen.getByTestId('pulse-sindustries-iframe');
    act(() => {
      fireEvent.load(iframe);
      vi.advanceTimersByTime(IFRAME_LOAD_TIMEOUT_MS + 1000);
    });

    // Iframe is still rendered; fallback never appeared.
    expect(screen.getByTestId('pulse-sindustries-iframe')).toBeTruthy();
    expect(screen.queryByTestId('pulse-sindustries-fallback')).toBeNull();
  });
});