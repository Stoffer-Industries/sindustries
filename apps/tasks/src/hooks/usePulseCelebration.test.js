import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePulseCelebration } from './usePulseCelebration.js';

const CONFETTI_BURST_DURATION_MS = 2800;

describe('usePulseCelebration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no bursts', () => {
    const { result } = renderHook(() => usePulseCelebration());
    expect(result.current.confettiBursts).toEqual([]);
  });

  it('triggerCelebration adds a burst to the state', () => {
    const { result } = renderHook(() => usePulseCelebration());

    act(() => {
      result.current.triggerCelebration();
    });

    expect(result.current.confettiBursts).toHaveLength(1);
    expect(result.current.confettiBursts[0]).toHaveProperty('id');
    expect(result.current.confettiBursts[0]).toHaveProperty('pieces');
  });

  it('produces unique burst IDs across successive triggers', () => {
    const { result } = renderHook(() => usePulseCelebration());

    act(() => {
      result.current.triggerCelebration();
      result.current.triggerCelebration();
      result.current.triggerCelebration();
    });

    const ids = result.current.confettiBursts.map((burst) => burst.id);
    expect(result.current.confettiBursts).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('removes the burst after CONFETTI_BURST_DURATION_MS', () => {
    const { result } = renderHook(() => usePulseCelebration());

    act(() => {
      result.current.triggerCelebration();
    });

    const burstId = result.current.confettiBursts[0].id;
    expect(result.current.confettiBursts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(CONFETTI_BURST_DURATION_MS - 1);
    });
    expect(result.current.confettiBursts.map((b) => b.id)).toContain(burstId);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.confettiBursts.map((b) => b.id)).not.toContain(burstId);
  });

  it('removes each burst independently when multiple are scheduled', () => {
    const { result } = renderHook(() => usePulseCelebration());

    act(() => {
      result.current.triggerCelebration();
      result.current.triggerCelebration();
    });
    const [firstId, secondId] = result.current.confettiBursts.map((b) => b.id);

    act(() => {
      vi.advanceTimersByTime(CONFETTI_BURST_DURATION_MS);
    });

    const remaining = result.current.confettiBursts.map((b) => b.id);
    expect(remaining).not.toContain(firstId);
    expect(remaining).not.toContain(secondId);
    expect(result.current.confettiBursts).toHaveLength(0);
  });

  it('clears pending timeouts on unmount', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    const { result, unmount } = renderHook(() => usePulseCelebration());

    act(() => {
      result.current.triggerCelebration();
      result.current.triggerCelebration();
    });

    expect(clearSpy).not.toHaveBeenCalled();
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('exposes hoverProps bound to the hover-motion handlers', () => {
    const { result } = renderHook(() => usePulseCelebration());
    expect(result.current.hoverProps).toEqual({
      onPointerEnter: expect.any(Function),
      onPointerMove: expect.any(Function),
      onPointerLeave: expect.any(Function)
    });
    expect(result.current.hoverProps.onPointerEnter).toBe(result.current.hoverProps.onPointerMove);
  });

  it('updateHoverMotion writes --pulse-* CSS variables on the target', () => {
    const { result } = renderHook(() => usePulseCelebration());

    const fakeElement = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
      style: {
        setProperty: vi.fn(),
        removeProperty: vi.fn()
      }
    };
    const event = { currentTarget: fakeElement, clientX: 100, clientY: 50 };

    act(() => {
      result.current.hoverProps.onPointerMove(event);
    });

    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-tilt', expect.stringMatching(/deg$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-sway-a', expect.stringMatching(/px$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-sway-b', expect.stringMatching(/px$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-up-a', expect.stringMatching(/px$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-up-b', expect.stringMatching(/px$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-down', expect.stringMatching(/px$/));
    expect(fakeElement.style.setProperty).toHaveBeenCalledWith('--pulse-speed', expect.stringMatching(/ms$/));
  });

  it('updateHoverMotion is a no-op when bounds have zero width or height', () => {
    const { result } = renderHook(() => usePulseCelebration());

    const fakeElement = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      style: {
        setProperty: vi.fn(),
        removeProperty: vi.fn()
      }
    };
    const event = { currentTarget: fakeElement, clientX: 100, clientY: 50 };

    act(() => {
      result.current.hoverProps.onPointerMove(event);
    });

    expect(fakeElement.style.setProperty).not.toHaveBeenCalled();
  });

  it('resetHoverMotion removes all --pulse-* CSS variables', () => {
    const { result } = renderHook(() => usePulseCelebration());

    const removedProps = [];
    const fakeElement = {
      style: {
        removeProperty: vi.fn((name) => removedProps.push(name))
      }
    };
    const event = { currentTarget: fakeElement };

    act(() => {
      result.current.hoverProps.onPointerLeave(event);
    });

    expect(removedProps).toEqual([
      '--pulse-tilt',
      '--pulse-sway-a',
      '--pulse-sway-b',
      '--pulse-up-a',
      '--pulse-up-b',
      '--pulse-down',
      '--pulse-speed'
    ]);
  });

  it('handles the lack of Web Audio gracefully (jsdom has no AudioContext)', () => {
    const { result } = renderHook(() => usePulseCelebration());

    // triggerCelebration should not throw in jsdom where AudioContext is undefined.
    expect(() => {
      act(() => {
        result.current.triggerCelebration();
      });
    }).not.toThrow();

    expect(result.current.confettiBursts).toHaveLength(1);
  });
});
