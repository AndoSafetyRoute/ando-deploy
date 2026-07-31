import { useCallback, useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';

// 손잡이를 위/아래로 드래그하면 실시간으로 시트 높이가 따라오고,
// 손을 떼면 가까운 상태(접힘/펼침)로 스냅한다. 단순 탭도 토글로 처리한다.
export function useDraggableSheet(
  containerHeight: number,
  collapsedRatio: number,
  expandedRatio: number,
  initialExpanded = false
) {
  const [sheetExpanded, setSheetExpanded] = useState(initialExpanded);
  const sheetAnim = useRef(new Animated.Value(initialExpanded ? 1 : 0)).current;

  const containerHeightRef = useRef(containerHeight);
  containerHeightRef.current = containerHeight;

  const sheetExpandedRef = useRef(sheetExpanded);
  sheetExpandedRef.current = sheetExpanded;

  const dragBaseRef = useRef(initialExpanded ? 1 : 0);

  const snapTo = useCallback(
    (expand: boolean) => {
      setSheetExpanded(expand);
      Animated.spring(sheetAnim, {
        toValue: expand ? 1 : 0,
        tension: 80,
        friction: 12,
        useNativeDriver: false,
      }).start();
    },
    [sheetAnim]
  );

  const toggleSheet = useCallback(() => {
    snapTo(!sheetExpandedRef.current);
  }, [snapTo]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        dragBaseRef.current = sheetExpandedRef.current ? 1 : 0;
        sheetAnim.stopAnimation();
      },
      onPanResponderMove: (_, gesture) => {
        const h = containerHeightRef.current;
        const collapsedH = h * collapsedRatio;
        const expandedH = h * expandedRatio;
        const range = Math.max(1, expandedH - collapsedH);
        const delta = -gesture.dy / range;
        const next = Math.min(1, Math.max(0, dragBaseRef.current + delta));
        sheetAnim.setValue(next);
      },
      onPanResponderRelease: (_, gesture) => {
        if (Math.abs(gesture.dy) < 10 && Math.abs(gesture.dx) < 10) {
          snapTo(!sheetExpandedRef.current);
          return;
        }

        const h = containerHeightRef.current;
        const collapsedH = h * collapsedRatio;
        const expandedH = h * expandedRatio;
        const range = Math.max(1, expandedH - collapsedH);
        const delta = -gesture.dy / range;
        const finalValue = dragBaseRef.current + delta;
        snapTo(finalValue > 0.5);
      },
    })
  ).current;

  const sheetHeight = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [containerHeight * collapsedRatio, containerHeight * expandedRatio],
  });

  return {
    sheetExpanded,
    sheetHeight,
    toggleSheet,
    snapTo,
    panHandlers: panResponder.panHandlers,
  };
}
