import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { C } from '../constants/colors';

interface Props {
  visible:   boolean;
  routeFrom: string;
  routeTo:   string;
  onSubmit:  (stars: number) => void;
  onSkip:    () => void;
}

const STARS = [1, 2, 3, 4, 5];

const STAR_LABELS: Record<number, string> = {
  1: '매우 불편했어요',
  2: '불편했어요',
  3: '보통이에요',
  4: '편리했어요',
  5: '매우 편리했어요',
};

export default function SatisfactionModal({ visible, routeFrom, routeTo, onSubmit, onSkip }: Props) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);

  const display = hovered || selected;

  const handleSubmit = () => {
    if (selected > 0) onSubmit(selected);
    else onSkip();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onSkip}>
      <View style={ss.overlay}>
        <View style={ss.card}>
          <View style={ss.topBar} />

          <Text style={ss.title}>안내가 완료되었어요!</Text>
          <Text style={ss.subtitle}>
            <Text style={ss.routeText}>{routeFrom}</Text>
            {'  →  '}
            <Text style={ss.routeText}>{routeTo}</Text>
          </Text>
          <Text style={ss.question}>이번 경로는 얼마나 편리하셨나요?</Text>

          {/* 별점 */}
          <View style={ss.starsRow}>
            {STARS.map(n => (
              <TouchableOpacity
                key={n}
                onPress={() => setSelected(n)}
                onPressIn={() => setHovered(n)}
                onPressOut={() => setHovered(0)}
                activeOpacity={0.7}
                style={ss.starBtn}
              >
                <Text style={[ss.star, n <= display && ss.starActive]}>★</Text>
              </TouchableOpacity>
            ))}
          </View>

          {display > 0 && (
            <Text style={ss.starLabel}>{STAR_LABELS[display]}</Text>
          )}

          <View style={ss.btnRow}>
            <TouchableOpacity style={ss.skipBtn} onPress={onSkip}>
              <Text style={ss.skipText}>건너뛰기</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[ss.submitBtn, selected === 0 && ss.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={selected === 0}
            >
              <Text style={ss.submitText}>저장</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ss = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 28, paddingBottom: 40,
    alignItems: 'center',
    elevation: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15, shadowRadius: 16,
  },
  topBar: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: C.border, marginBottom: 20,
  },
  title: {
    fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 6,
  },
  subtitle: {
    fontSize: 13, color: C.textSub, marginBottom: 20, textAlign: 'center',
  },
  routeText: {
    color: C.primary, fontWeight: '700',
  },
  question: {
    fontSize: 15, color: C.text, fontWeight: '600', marginBottom: 18,
  },
  starsRow: {
    flexDirection: 'row', gap: 8, marginBottom: 10,
  },
  starBtn: { padding: 4 },
  star: {
    fontSize: 40, color: C.border,
  },
  starActive: {
    color: C.warn,
  },
  starLabel: {
    fontSize: 14, color: C.textSub, fontWeight: '600', marginBottom: 8, height: 20,
  },
  btnRow: {
    flexDirection: 'row', gap: 12, marginTop: 22, width: '100%',
  },
  skipBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 14,
    borderWidth: 1.5, borderColor: C.border, alignItems: 'center',
  },
  skipText: { fontSize: 15, fontWeight: '600', color: C.textSub },
  submitBtn: {
    flex: 2, paddingVertical: 14, borderRadius: 14,
    backgroundColor: C.primary, alignItems: 'center',
    elevation: 3, shadowColor: C.primary,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
  },
  submitBtnDisabled: { backgroundColor: C.textMute, elevation: 0, shadowOpacity: 0 },
  submitText: { fontSize: 15, fontWeight: '800', color: C.white },
});
