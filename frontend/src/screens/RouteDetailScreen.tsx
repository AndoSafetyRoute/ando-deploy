import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { C } from "../constants/colors";
import {
  getRoutes,
  updateSatisfaction,
  deleteRoute,
  formatDuration,
  getSlopeEffort,
  RouteRecord,
  SegmentTime,
} from "../utils/storage";
import { getAuthToken, submitFeedback, deleteUserRoute } from "../api";

const NAVY = "#1B0F4A";
const WHITE = "#FFFFFF";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT = "#111111";
const TEXT_GRAY = "#666666";
const TEXT_MUTE = "#9A9A9A";

const EFFORT_CONFIG = {
  easy: {
    label: "쉬움",
    color: C.success,
    bg: "#E8F8F5",
    icon: "😊",
  },
  normal: {
    label: "보통",
    color: C.warn,
    bg: "#FFF8E6",
    icon: "😐",
  },
  hard: {
    label: "힘듦",
    color: C.danger,
    bg: "#FFF0F0",
    icon: "😓",
  },
};

const MODE_INFO: Record<string, { icon: string; label: string; color: string }> =
  {
    walk: {
      icon: "🚶",
      label: "도보",
      color: C.primary,
    },
    transit: {
      icon: "🚌",
      label: "대중교통",
      color: C.subway,
    },
    car: {
      icon: "🚗",
      label: "자동차",
      color: C.car,
    },
  };

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function formatDistance(meter: number) {
  if (!Number.isFinite(meter)) return "0m";

  if (meter >= 1000) {
    return `${(meter / 1000).toFixed(1)}km`;
  }

  return `${Math.round(meter)}m`;
}

function SlopeBar({ slope }: { slope: number }) {
  const absSlope = Math.abs(Number(slope) || 0);
  const capped = Math.min(absSlope, 10);
  const effort = getSlopeEffort(absSlope);
  const cfg = EFFORT_CONFIG[effort];

  return (
    <View style={bar.wrap}>
      <View style={bar.bg}>
        <View
          style={[
            bar.fill,
            {
              width: `${capped * 10}%`,
              backgroundColor: cfg.color,
            },
          ]}
        />
      </View>

      <Text style={[bar.label, { color: cfg.color }]}>
        {absSlope.toFixed(1)}%
      </Text>
    </View>
  );
}

function SegmentRow({ seg, index }: { seg: SegmentTime; index: number }) {
  const slope = Math.abs(Number(seg.slopePercent) || 0);
  const effort = getSlopeEffort(slope);
  const cfg = EFFORT_CONFIG[effort];

  return (
    <View style={styles.segRow}>
      <View style={styles.segIndex}>
        <Text style={styles.segIndexText}>{index + 1}</Text>
      </View>

      <View style={styles.segMain}>
        <View style={styles.segTop}>
          <Text style={styles.segDistance}>
            {Math.round(seg.distanceM)}m 구간
          </Text>

          <View style={[styles.effortBadge, { backgroundColor: cfg.bg }]}>
            <Text style={styles.effortIcon}>{cfg.icon}</Text>
            <Text style={[styles.effortLabel, { color: cfg.color }]}>
              {cfg.label}
            </Text>
          </View>
        </View>

        <SlopeBar slope={seg.slopePercent} />
      </View>

      <View style={styles.segTime}>
        <Text style={styles.segTimeText}>{formatDuration(seg.elapsedMs)}</Text>
      </View>
    </View>
  );
}

function EditableStars({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (n: number) => void;
}) {
  const [local, setLocal] = useState(value ?? 0);

  const handlePress = (n: number) => {
    setLocal(n);
    onChange(n);
  };

  return (
    <View style={styles.starsRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity
          key={n}
          onPress={() => handlePress(n)}
          activeOpacity={0.75}
          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
        >
          <Text style={[styles.starEdit, n <= local && styles.starEditFilled]}>
            ★
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function Header({ onDelete }: { onDelete?: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        style={styles.headerIconButton}
        onPress={() => router.back()}
      >
        <Ionicons name="chevron-back" size={28} color={NAVY} />
      </TouchableOpacity>

      <Text style={styles.headerTitle}>경로 상세</Text>

      <View style={{ flexDirection: "row" }}>
        {onDelete && (
          <TouchableOpacity style={styles.headerIconButton} onPress={onDelete}>
            <Ionicons name="trash-outline" size={24} color={C.danger} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.replace("/")}
        >
          <Ionicons name="home-outline" size={26} color={NAVY} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function RouteDetailScreen() {
  const params = useLocalSearchParams();
  const routeId = getParam(params.routeId);

  const [record, setRecord] = useState<RouteRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      async function load() {
        setLoading(true);

        const routes = await getRoutes();
        const found = routes.find((r) => r.id === routeId) ?? null;

        if (active) {
          setRecord(found);
          setLoading(false);
        }
      }

      load();

      return () => {
        active = false;
      };
    }, [routeId])
  );

  const handleStarChange = useCallback(
    async (stars: number) => {
      if (!routeId) return;

      await updateSatisfaction(routeId, stars);
      setRecord((prev) => (prev ? { ...prev, satisfaction: stars } : prev));

      try {
        const token = await getAuthToken();
        const serverRouteId = (record as any)?.serverRouteId;

        if (token && serverRouteId) {
          await submitFeedback(serverRouteId, stars, token);
        }
      } catch (error) {
        console.log("[FE] 만족도 서버 저장 실패:", error);
      }
    },
    [routeId, record]
  );

  const handleDelete = useCallback(() => {
    if (!routeId) return;

    Alert.alert("경로 삭제", "이 경로 기록을 삭제할까요? 되돌릴 수 없습니다.", [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: async () => {
          await deleteRoute(routeId);
          try {
            const token = await getAuthToken();
            const serverRouteId = (record as any)?.serverRouteId;
            if (token && serverRouteId) {
              await deleteUserRoute(serverRouteId, token);
            }
          } catch (error) {
            console.log("[FE] 경로 서버 삭제 실패:", error);
          }
          router.back();
        },
      },
    ]);
  }, [routeId, record]);

  if (loading) {
    return (
      <SafeAreaView style={styles.screen}>
        <Header />

        <View style={styles.center}>
          <ActivityIndicator size="large" color={NAVY} />
          <Text style={styles.loadingText}>경로 기록을 불러오는 중입니다</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!record) {
    return (
      <SafeAreaView style={styles.screen}>
        <Header />

        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🗺</Text>
          <Text style={styles.emptyTitle}>경로 기록을 찾을 수 없어요</Text>
          <Text style={styles.emptyDesc}>
            저장된 경로가 삭제되었거나 올바르지 않은 기록입니다.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const info = MODE_INFO[record.mode] ?? MODE_INFO.walk;
  const date = new Date(record.date);

  const dateStr = `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

  const segments = record.segments ?? [];

  const totalDistance = segments.reduce(
    (sum, seg) => sum + (seg.distanceM ?? 0),
    0
  );

  const hardCount = segments.filter(
    (s) => getSlopeEffort(Math.abs(s.slopePercent)) === "hard"
  ).length;

  const normalCount = segments.filter(
    (s) => getSlopeEffort(Math.abs(s.slopePercent)) === "normal"
  ).length;

  const easyCount = segments.filter(
    (s) => getSlopeEffort(Math.abs(s.slopePercent)) === "easy"
  ).length;

  return (
    <SafeAreaView style={styles.screen}>
      <Header onDelete={handleDelete} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          <View style={styles.heroIconBox}>
            <Text style={styles.heroIcon}>{info.icon}</Text>
          </View>

          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>경로 상세 기록</Text>
            <Text style={styles.heroDesc}>
              이동 경로의 시간, 거리, 경사도 정보를 확인할 수 있어요.
            </Text>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <View style={[styles.summaryBar, { backgroundColor: info.color }]} />

          <View style={styles.summaryBody}>
            <View style={styles.summaryTop}>
              <View
                style={[
                  styles.modeChip,
                  { backgroundColor: `${info.color}18` },
                ]}
              >
                <Text style={styles.modeIcon}>{info.icon}</Text>
                <Text style={[styles.modeLabel, { color: info.color }]}>
                  {info.label}
                </Text>
              </View>

              <Text style={styles.summaryDate}>{dateStr}</Text>
            </View>

            <View style={styles.placeBox}>
              <View style={styles.placeRow}>
                <View style={[styles.dot, { backgroundColor: C.success }]} />
                <Text style={styles.placeText} numberOfLines={1}>
                  {record.from || "출발지"}
                </Text>
              </View>

              <View style={styles.placeDivider} />

              <View style={styles.placeRow}>
                <View style={[styles.dot, { backgroundColor: C.danger }]} />
                <Text style={styles.placeText} numberOfLines={1}>
                  {record.to || "도착지"}
                </Text>
              </View>
            </View>

            <View style={styles.summaryStats}>
              <View style={styles.statChip}>
                <Text style={styles.statIcon}>⏱</Text>
                <Text style={styles.statLabel}>총 소요</Text>
                <Text style={styles.statValue}>
                  {formatDuration(record.totalDurationMs)}
                </Text>
              </View>

              <View style={styles.statChip}>
                <Text style={styles.statIcon}>📍</Text>
                <Text style={styles.statLabel}>구간 수</Text>
                <Text style={styles.statValue}>{segments.length}구간</Text>
              </View>

              <View style={styles.statChip}>
                <Text style={styles.statIcon}>📏</Text>
                <Text style={styles.statLabel}>총 거리</Text>
                <Text style={styles.statValue}>{formatDistance(totalDistance)}</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.ratingCard}>
          <Text style={styles.cardTitle}>만족도 평가</Text>
          <Text style={styles.cardDesc}>이 경로에 대한 별점을 남겨주세요.</Text>

          <EditableStars
            value={record.satisfaction}
            onChange={handleStarChange}
          />

          {record.satisfaction !== null && (
            <Text style={styles.ratingConfirm}>
              ★ {record.satisfaction}점 저장됨
            </Text>
          )}
        </View>

        <View style={styles.effortSummaryCard}>
          <Text style={styles.cardTitle}>구간별 난이도 요약</Text>
          <Text style={styles.cardDesc}>경사도 기준으로 구간을 분류했어요.</Text>

          <View style={styles.effortSummaryRow}>
            {[
              { effort: "easy" as const, count: easyCount },
              { effort: "normal" as const, count: normalCount },
              { effort: "hard" as const, count: hardCount },
            ].map(({ effort, count }) => {
              const cfg = EFFORT_CONFIG[effort];

              return (
                <View
                  key={effort}
                  style={[styles.effortSummaryItem, { backgroundColor: cfg.bg }]}
                >
                  <Text style={styles.effortSummaryIcon}>{cfg.icon}</Text>
                  <Text style={[styles.effortSummaryLabel, { color: cfg.color }]}>
                    {cfg.label}
                  </Text>
                  <Text style={[styles.effortSummaryCount, { color: cfg.color }]}>
                    {count}구간
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        <View style={styles.segmentsCard}>
          <Text style={styles.cardTitle}>구간별 소요 시간</Text>
          <Text style={styles.cardDesc}>5m 단위 · 경사도 기준 난이도</Text>

          {segments.length === 0 ? (
            <View style={styles.noSegmentBox}>
              <Text style={styles.noSegmentText}>저장된 구간 정보가 없습니다.</Text>
            </View>
          ) : (
            segments.map((seg, index) => (
              <React.Fragment key={`${seg.index ?? index}-${index}`}>
                <SegmentRow seg={seg} index={index} />
                {index < segments.length - 1 && (
                  <View style={styles.segDivider} />
                )}
              </React.Fragment>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const shadowStyle = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  android: {
    elevation: 4,
  },
});

const bar = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },

  bg: {
    flex: 1,
    height: 8,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 999,
    overflow: "hidden",
  },

  fill: {
    height: "100%",
    borderRadius: 999,
  },

  label: {
    fontSize: 11,
    fontWeight: "900",
    width: 42,
    textAlign: "right",
  },
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: WHITE,
    paddingHorizontal: 20,
  },

  header: {
    height: 62,
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
  },

  headerIconButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
  },

  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 21,
    fontWeight: "800",
    color: TEXT,
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: TEXT_GRAY,
    fontWeight: "700",
  },

  emptyIcon: {
    fontSize: 56,
    marginBottom: 12,
  },

  emptyTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: TEXT,
  },

  emptyDesc: {
    marginTop: 8,
    fontSize: 13,
    color: TEXT_GRAY,
    textAlign: "center",
    lineHeight: 20,
    fontWeight: "600",
  },

  scroll: {
    flex: 1,
  },

  scrollContent: {
    paddingTop: 18,
    paddingBottom: 50,
  },

  heroCard: {
    backgroundColor: NAVY,
    borderRadius: 26,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
    ...shadowStyle,
  },

  heroIconBox: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.16)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 15,
  },

  heroIcon: {
    fontSize: 29,
  },

  heroTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: WHITE,
  },

  heroDesc: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: "rgba(255,255,255,0.74)",
    fontWeight: "600",
  },

  summaryCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    flexDirection: "row",
    overflow: "hidden",
    marginBottom: 18,
    ...shadowStyle,
  },

  summaryBar: {
    width: 5,
  },

  summaryBody: {
    flex: 1,
    padding: 16,
  },

  summaryTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },

  modeChip: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  modeIcon: {
    fontSize: 13,
    marginRight: 4,
  },

  modeLabel: {
    fontSize: 12,
    fontWeight: "900",
  },

  summaryDate: {
    marginLeft: "auto",
    fontSize: 11,
    color: TEXT_MUTE,
    fontWeight: "700",
  },

  placeBox: {
    backgroundColor: LIGHT_GRAY,
    borderRadius: 17,
    padding: 12,
  },

  placeRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginRight: 9,
  },

  placeText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "800",
    color: TEXT,
  },

  placeDivider: {
    height: 1,
    backgroundColor: BORDER_GRAY,
    marginVertical: 8,
    marginLeft: 18,
  },

  summaryStats: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },

  statChip: {
    flex: 1,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 15,
    paddingVertical: 11,
    paddingHorizontal: 8,
  },

  statIcon: {
    fontSize: 16,
  },

  statLabel: {
    marginTop: 4,
    fontSize: 10,
    color: TEXT_GRAY,
    fontWeight: "800",
  },

  statValue: {
    marginTop: 3,
    fontSize: 12,
    color: TEXT,
    fontWeight: "900",
  },

  ratingCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    marginBottom: 18,
    ...shadowStyle,
  },

  cardTitle: {
    fontSize: 19,
    fontWeight: "900",
    color: TEXT,
  },

  cardDesc: {
    marginTop: 5,
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "600",
  },

  starsRow: {
    flexDirection: "row",
    marginTop: 14,
    gap: 6,
  },

  starEdit: {
    fontSize: 34,
    color: BORDER_GRAY,
  },

  starEditFilled: {
    color: C.warn,
  },

  ratingConfirm: {
    marginTop: 8,
    fontSize: 13,
    color: C.warn,
    fontWeight: "900",
  },

  effortSummaryCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    marginBottom: 18,
    ...shadowStyle,
  },

  effortSummaryRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },

  effortSummaryItem: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 13,
    alignItems: "center",
  },

  effortSummaryIcon: {
    fontSize: 24,
  },

  effortSummaryLabel: {
    marginTop: 5,
    fontSize: 12,
    fontWeight: "900",
  },

  effortSummaryCount: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: "900",
  },

  segmentsCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    ...shadowStyle,
  },

  noSegmentBox: {
    marginTop: 14,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 16,
    padding: 18,
    alignItems: "center",
  },

  noSegmentText: {
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "800",
  },

  segRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },

  segIndex: {
    width: 32,
    height: 32,
    borderRadius: 14,
    backgroundColor: "rgba(27, 15, 74, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },

  segIndexText: {
    fontSize: 13,
    fontWeight: "900",
    color: NAVY,
  },

  segMain: {
    flex: 1,
  },

  segTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },

  segDistance: {
    fontSize: 13,
    fontWeight: "900",
    color: TEXT,
    flex: 1,
  },

  effortBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },

  effortIcon: {
    fontSize: 11,
    marginRight: 3,
  },

  effortLabel: {
    fontSize: 11,
    fontWeight: "900",
  },

  segTime: {
    minWidth: 58,
    alignItems: "flex-end",
  },

  segTimeText: {
    fontSize: 12,
    color: TEXT_GRAY,
    fontWeight: "900",
  },

  segDivider: {
    height: 1,
    backgroundColor: BORDER_GRAY,
    marginLeft: 44,
  },
});