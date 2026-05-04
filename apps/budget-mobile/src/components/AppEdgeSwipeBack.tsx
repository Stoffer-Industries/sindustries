import type { NavigationContainerRef } from '@react-navigation/native';
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/types';

type Props = {
  navigationRef: React.RefObject<NavigationContainerRef<RootStackParamList> | null>;
};

export function AppEdgeSwipeBack({ navigationRef }: Props) {
  const insets = useSafeAreaInsets();

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(18)
        .failOffsetY([-24, 24])
        .runOnJS(true)
        .onEnd((e) => {
          const navigation = navigationRef.current;
          if (!navigation?.canGoBack()) return;

          const vx = e.velocityX ?? 0;
          if (e.translationX > 48 || vx > 500) {
            navigation.goBack();
          }
        }),
    [navigationRef]
  );

  return (
    <GestureDetector gesture={pan}>
      <View
        pointerEvents="box-only"
        style={{
          position: 'absolute',
          left: 0,
          top: insets.top + 44,
          bottom: 0,
          width: insets.left + 36,
          zIndex: 1000
        }}
      />
    </GestureDetector>
  );
}
