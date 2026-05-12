import React from 'react';
import { useWindowDimensions, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

export type TimeseriesPoint = {
  day: string; // YYYY-MM-DD
  amountCents: number;
};

export function CategoryTimeseriesChart({
  points,
  height = 120
}: {
  points: TimeseriesPoint[];
  height?: number;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.max(280, Math.min(520, Math.floor(screenWidth - 32)));

  const values = points.map((p) => p.amountCents);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = Math.max(1, max - min);

  const padding = 10;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const polyPoints =
    points.length <= 1
      ? ''
      : points
          .map((p, idx) => {
            const x = padding + (idx / (points.length - 1)) * innerW;
            const y = padding + (1 - (p.amountCents - min) / span) * innerH;
            return `${x},${y}`;
          })
          .join(' ');

  return (
    <View style={{ borderRadius: 12, overflow: 'hidden' }}>
      <Svg width={width} height={height}>
        <Polyline points={polyPoints} stroke="#111827" strokeWidth={2} />
      </Svg>
    </View>
  );
}

