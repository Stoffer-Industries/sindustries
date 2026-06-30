export function ConfettiLayer({ bursts }) {
  return (
    <div className="confetti-layer" aria-hidden="true">
      {bursts.map((burst) => (
        <div key={burst.id} className="confetti-burst">
          {burst.pieces.map((piece) => (
            <span
              key={`${burst.id}-${piece.id}`}
              className="confetti-piece"
              style={{
                '--confetti-color': piece.color,
                '--confetti-start-x': `${piece.startX}vw`,
                '--confetti-drift': `${piece.drift}px`,
                '--confetti-rotation': `${piece.rotation}deg`,
                '--confetti-size': `${piece.size}px`,
                '--confetti-duration': `${piece.duration}ms`,
                '--confetti-delay': `${piece.delay}ms`
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
