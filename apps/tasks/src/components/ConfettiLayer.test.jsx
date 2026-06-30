import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfettiLayer } from './ConfettiLayer.jsx';

describe('ConfettiLayer', () => {
  it('renders nothing inside the layer when bursts is empty', () => {
    const { container } = render(<ConfettiLayer bursts={[]} />);
    const layer = container.querySelector('.confetti-layer');
    expect(layer).not.toBeNull();
    expect(layer.querySelectorAll('.confetti-burst').length).toBe(0);
  });

  it('renders a piece span per confetti piece with inline custom properties', () => {
    const bursts = [
      {
        id: 'b1',
        pieces: [
          {
            id: 'p1',
            color: '#ff00aa',
            startX: 12.5,
            drift: 40,
            rotation: 90,
            size: 8,
            duration: 1200,
            delay: 0
          },
          {
            id: 'p2',
            color: '#00ccff',
            startX: 80,
            drift: -20,
            rotation: 180,
            size: 6,
            duration: 1500,
            delay: 100
          }
        ]
      }
    ];
    const { container } = render(<ConfettiLayer bursts={bursts} />);
    const pieces = container.querySelectorAll('.confetti-piece');
    expect(pieces.length).toBe(2);
    expect(pieces[0].style.getPropertyValue('--confetti-color')).toBe('#ff00aa');
    expect(pieces[1].style.getPropertyValue('--confetti-start-x')).toBe('80vw');
  });
});
