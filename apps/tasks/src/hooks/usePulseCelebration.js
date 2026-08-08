import { useCallback, useEffect, useRef, useState } from 'react';
import { createConfettiPieces } from '../utils/helpers.js';

const CONFETTI_BURST_DURATION_MS = 2800;
const SALES_BELL_NOTES = [523.25, 659.25, 783.99, 1046.5];
const SALES_BELL_NOTE_SPACING_S = 0.09;
const SALES_BELL_NOTE_DURATION_S = 0.24;
const SALES_BELL_LEAD_GAIN_PEAK = 0.17;
const SALES_BELL_SHIMMER_GAIN_PEAK = 0.06;
const SALES_BELL_GAIN_RAMP_S = 0.02;
const SALES_BELL_START_OFFSET_S = 0.02;

/**
 * Owns the Pulse brand-button celebration: the sales bell, the confetti burst,
 * and the hover-tilt CSS animation. All state/effects are scoped to the
 * component's mount cycle so the App.jsx render tree stays a UI shell.
 *
 * Returns:
 *   - confettiBursts: array of { id, pieces } to feed <ConfettiLayer bursts={...} />
 *   - triggerCelebration: click handler for the brand button
 *   - hoverProps: spread onto the brand button for onPointerEnter/Move/Leave
 */
export function usePulseCelebration() {
  const [confettiBursts, setConfettiBursts] = useState([]);
  const confettiTimeoutsRef = useRef(new Map());
  const audioContextRef = useRef(null);

  // Cleanup pending confetti timeouts and the lazily-created AudioContext on unmount.
  useEffect(() => {
    return () => {
      for (const timeoutId of confettiTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      confettiTimeoutsRef.current.clear();
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  const playSalesBell = useCallback(async () => {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextCtor();
      }

      const context = audioContextRef.current;
      if (context.state === 'suspended') {
        await context.resume();
      }

      const now = context.currentTime + SALES_BELL_START_OFFSET_S;

      SALES_BELL_NOTES.forEach((frequency, index) => {
        const start = now + index * SALES_BELL_NOTE_SPACING_S;
        const duration = SALES_BELL_NOTE_DURATION_S;

        const lead = context.createOscillator();
        const leadGain = context.createGain();
        lead.type = 'square';
        lead.frequency.setValueAtTime(frequency, start);
        leadGain.gain.setValueAtTime(0.001, start);
        leadGain.gain.exponentialRampToValueAtTime(SALES_BELL_LEAD_GAIN_PEAK, start + SALES_BELL_GAIN_RAMP_S);
        leadGain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        lead.connect(leadGain);
        leadGain.connect(context.destination);
        lead.start(start);
        lead.stop(start + duration + 0.03);

        const shimmer = context.createOscillator();
        const shimmerGain = context.createGain();
        shimmer.type = 'triangle';
        shimmer.frequency.setValueAtTime(frequency * 2, start);
        shimmerGain.gain.setValueAtTime(0.001, start);
        shimmerGain.gain.exponentialRampToValueAtTime(SALES_BELL_SHIMMER_GAIN_PEAK, start + SALES_BELL_GAIN_RAMP_S);
        shimmerGain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        shimmer.connect(shimmerGain);
        shimmerGain.connect(context.destination);
        shimmer.start(start);
        shimmer.stop(start + duration + 0.03);
      });
    } catch {
      // No-op on browsers that block or lack Web Audio.
    }
  }, []);

  const triggerCelebration = useCallback(() => {
    void playSalesBell();

    const id = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const pieces = createConfettiPieces();
    setConfettiBursts((current) => [...current, { id, pieces }]);

    const timeoutId = window.setTimeout(() => {
      setConfettiBursts((current) => current.filter((burst) => burst.id !== id));
      confettiTimeoutsRef.current.delete(id);
    }, CONFETTI_BURST_DURATION_MS);

    confettiTimeoutsRef.current.set(id, timeoutId);
  }, [playSalesBell]);

  const updateHoverMotion = useCallback((event) => {
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    const x = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);
    const centerX = x - 0.5;
    const centerY = y - 0.5;
    const distance = Math.min(Math.hypot(centerX, centerY), 0.75);

    const sway = centerX * 11;
    const lift = 3 + Math.abs(centerY) * 7;
    const speed = 460 + Math.round(distance * 360);

    element.style.setProperty('--pulse-tilt', `${(centerX * 5.5).toFixed(2)}deg`);
    element.style.setProperty('--pulse-sway-a', `${sway.toFixed(2)}px`);
    element.style.setProperty('--pulse-sway-b', `${(-sway * 0.72).toFixed(2)}px`);
    element.style.setProperty('--pulse-up-a', `-${lift.toFixed(2)}px`);
    element.style.setProperty('--pulse-up-b', `-${(lift + 1.8).toFixed(2)}px`);
    element.style.setProperty('--pulse-down', `${(centerY * 1.6).toFixed(2)}px`);
    element.style.setProperty('--pulse-speed', `${speed}ms`);
  }, []);

  const resetHoverMotion = useCallback((event) => {
    const element = event.currentTarget;
    element.style.removeProperty('--pulse-tilt');
    element.style.removeProperty('--pulse-sway-a');
    element.style.removeProperty('--pulse-sway-b');
    element.style.removeProperty('--pulse-up-a');
    element.style.removeProperty('--pulse-up-b');
    element.style.removeProperty('--pulse-down');
    element.style.removeProperty('--pulse-speed');
  }, []);

  const hoverProps = {
    onPointerEnter: updateHoverMotion,
    onPointerMove: updateHoverMotion,
    onPointerLeave: resetHoverMotion
  };

  return {
    confettiBursts,
    triggerCelebration,
    hoverProps
  };
}
