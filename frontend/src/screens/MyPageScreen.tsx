import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { goHome } from "../utils/navigation";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { C } from "../constants/colors";
import {
  getRoutes,
  saveRoutes,
  formatDuration,
  RouteRecord,
} from "../utils/storage";
import {
  classifySlopeZoneForMyPage,
  MYPAGE_ZONE_COLORS,
  type MyPageSlopeZoneKey,
} from "../utils/slopeZone";
import {
  getAuthToken,
  getUserRoutes,
  getUserStats,
  getPersonalizationStatus,
  UserStats,
  PersonalizationStatus,
} from "../api";

const NAVY = "#1B0F4A";
const WHITE = "#FFFFFF";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT = "#111111";
const TEXT_GRAY = "#666666";
const TEXT_MUTE = "#9A9A9A";

const MODE_INFO: Record<string, { icon: string; label: string; color: string }> = {
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

// 오르막/내리막을 나눠서 보여준다 — 유형별 임계값은 안내 중 지도와 동일하되
// (utils/slopeZone.ts), 방향별로 색 계열을 분리(오르막 노랑/주황, 내리막
// 하늘/파랑)해서 같은 "완만"이라도 오르막인지 내리막인지 한눈에 구분되게 했다.
// forbidden 칸은 안 둔다 — 임계값이 넓어 실측상 사실상 안 나오고, 혹시
// 나와도 classifySlopeZoneForMyPage가 같은 방향의 warning에 합산한다(경로상세
// "구간별 난이도 요약"은 그대로 4단계 유지 — 거긴 안 바꾸기로 함).
const SLOPE_ZONES: { key: MyPageSlopeZoneKey; emoji: string; label: string; color: string }[] = [
  { key: "flat",         emoji: "😊", label: "평지",       color: MYPAGE_ZONE_COLORS.flat },
  { key: "up_optimal",   emoji: "🙂", label: "오르막 완만", color: MYPAGE_ZONE_COLORS.up_optimal },
  { key: "up_warning",   emoji: "😓", label: "오르막 주의", color: MYPAGE_ZONE_COLORS.up_warning },
  { key: "down_optimal", emoji: "🙂", label: "내리막 완만", color: MYPAGE_ZONE_COLORS.down_optimal },
  { key: "down_warning", emoji: "😓", label: "내리막 주의", color: MYPAGE_ZONE_COLORS.down_warning },
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statChip}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SlopeBar({
  emoji,
  label,
  ms,
  maxMs,
  color,
}: {
  emoji: string;
  label: string;
  ms: number;
  maxMs: number;
  color: string;
}) {
  const pct = maxMs > 0 ? Math.round((ms / maxMs) * 100) : 0;

  return (
    <View style={styles.slopeRow}>
      <View style={[styles.slopeIconBox, { backgroundColor: `${color}18` }]}>
        <Text style={styles.slopeEmoji}>{emoji}</Text>
      </View>

      <View style={styles.slopeInfo}>
        <View style={styles.slopeLabelRow}>
          <Text style={styles.slopeName}>{label}</Text>
        </View>

        <View style={styles.slopeBarBg}>
          <View
            style={[
              styles.slopeBarFill,
              {
                width: `${pct}%`,
                backgroundColor: color,
              },
            ]}
          />
        </View>
      </View>

      <Text style={styles.slopeTime}>
        {ms > 0 ? formatDuration(ms) : "—"}
      </Text>
    </View>
  );
}

function RouteCard({
  record,
}: {
  record: RouteRecord;
}) {
  const info = MODE_INFO[record.mode] ?? MODE_INFO.walk;
  const date = new Date(record.date);

  const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;

  const durationText =
    record.totalDurationMs > 0 ? formatDuration(record.totalDurationMs) : null;

  return (
    <TouchableOpacity
      style={styles.routeCard}
      activeOpacity={0.86}
      onPress={() =>
        router.push({
          pathname: "/route-detail" as any,
          params: { routeId: record.id },
        })
      }
    >
      <View style={[styles.routeCardBar, { backgroundColor: info.color }]} />

      <View style={styles.routeCardBody}>
        <View style={styles.routeCardTop}>
          <View style={[styles.modeChip, { backgroundColor: `${info.color}18` }]}>
            <Text style={styles.modeIcon}>{info.icon}</Text>
            <Text style={[styles.modeLabel, { color: info.color }]}>
              {info.label}
            </Text>
          </View>

          {durationText && (
            <View style={styles.durationChip}>
              <Text style={styles.durationText}>⏱ {durationText}</Text>
            </View>
          )}

          <Text style={styles.dateText}>{dateStr}</Text>
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
      </View>

      <Text style={styles.cardArrow}>›</Text>
    </TouchableOpacity>
  );
}

export default function MyPageScreen() {
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [personalization, setPersonalization] = useState<PersonalizationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      (async () => {
        setLoading(true);

        // 1. 로컬 데이터 즉시 표시
        const localRoutes = await getRoutes();

        if (!active) return;

        setRoutes(localRoutes);
        setLoading(false);

        // 2. 서버 데이터 백그라운드 갱신
        try {
          const token = await getAuthToken();

          if (!token || !active) return;

          const [rawRoutes, serverStats, pStatus] = await Promise.all([
            getUserRoutes(token).catch(() => [] as any[]),
            getUserStats(token),
            getPersonalizationStatus(token).catch(() => null),
          ]);

          if (!active) return;

          setPersonalization(pStatus);

          if (rawRoutes.length > 0) {
            const mapped: RouteRecord[] = rawRoutes.map((r: any) => ({
              ...r,
              id: String(r.id),
              serverRouteId: r.id,
              mode: r.mode ?? "walk",
              segments: r.segments ?? [],
              totalDurationMs: r.totalDurationMs ?? 0,
            }));

            setRoutes(mapped);
            saveRoutes(mapped).catch(() => {});
          }

          setStats(serverStats);
        } catch {
          // 서버 실패 시 로컬 데이터 유지
        }
      })();

      return () => {
        active = false;
      };
    }, [])
  );

  const slopeMs: Record<MyPageSlopeZoneKey, number> = {
    flat: 0,
    up_optimal: 0,
    up_warning: 0,
    down_optimal: 0,
    down_warning: 0,
  };

  // 유형별 임계값 분류라 route.walkerType이 필요 — classifySlopeZoneForMyPage가
  // 안내 중 지도 색과 동일 판정 위에 방향(오르막/내리막)만 더 나눈다(이전엔
  // 여기만 유형 무관 고정 2%/5% 컷이었음). 예전 버그: getSlopeEffort(segment.
  // slopePercent)가 절댓값 없이 호출돼 내리막 구간이 전부 "평지"로 잘못
  // 집계됐다 — classifySlopeZoneForMyPage는 내부에서 abs 처리.
  routes.forEach((route) => {
    (route.segments ?? []).forEach((segment) => {
      const zone = classifySlopeZoneForMyPage(segment.slopePercent, route.walkerType);
      slopeMs[zone] += segment.elapsedMs ?? 0;
    });
  });

  const maxSlopeMs = Math.max(...Object.values(slopeMs), 1);

  const totalDistM = routes.reduce(
    (sum, route) =>
      sum +
      (route.segments ?? []).reduce(
        (segmentSum, segment) => segmentSum + (segment.distanceM ?? 0),
        0
      ),
    0
  );

  const totalDurMs = routes.reduce(
    (sum, route) => sum + (route.totalDurationMs ?? 0),
    0
  );

  const totalRoutes = routes.length;

  const distKm = ((stats?.total_distance_m ?? totalDistM) / 1000).toFixed(1);
  const durMin = Math.floor((stats?.total_duration_ms ?? totalDurMs) / 60000);
  const durH = Math.floor(durMin / 60);
  const durM = durMin % 60;
  const durStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;

  const avgSlope = stats?.avg_slope_pct ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      {/* 설정 페이지와 맞춘 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>마이페이지</Text>

        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={goHome}
        >
          <Ionicons name="home-outline" size={26} color={NAVY} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={NAVY} />
          <Text style={styles.loadingText}>기록을 불러오는 중입니다</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.profileCard}>
            <View style={styles.profileIcon}>
              <Text style={styles.profileEmoji}>👤</Text>
            </View>

            <View style={{ flex: 1 }}>
              <Text style={styles.profileTitle}>나의 이동 기록</Text>
              <Text style={styles.profileDesc}>
                이용한 경로와 이동 통계를 한눈에 확인할 수 있어요.
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>통계</Text>
              <Text style={styles.sectionDesc}>누적 경로 정보</Text>
            </View>

            <View style={styles.statsGrid}>
              <StatChip
                label="경로"
                value={`${stats?.total_routes ?? totalRoutes}개`}
              />
              <StatChip label="총 거리" value={`${distKm}km`} />
              <StatChip label="총 시간" value={durStr || "—"} />
            </View>

            <View style={styles.statsGrid}>
              <StatChip label="평균 경사" value={`${avgSlope.toFixed(2)}%`} />
              <StatChip label="저장 경로" value={`${routes.length}개`} />
            </View>
          </View>

          {personalization && personalization.total_samples > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>개인화 학습</Text>
                <Text style={styles.sectionDesc}>
                  {personalization.calibrated ? "맞춤 적용 중" : "학습 중"}
                </Text>
              </View>

              <View style={styles.slopeCard}>
                <Text style={{ fontSize: 13, color: TEXT_GRAY, marginBottom: 8, lineHeight: 19 }}>
                  {personalization.calibrated
                    ? "평지 속도 학습이 끝나 소요시간이 내 걸음에 맞춰집니다."
                    : `평지를 ${Math.round(personalization.flat_progress_m)} / ${Math.round(
                        personalization.flat_target_m,
                      )}m 걸으면 소요시간이 내 걸음에 맞춰집니다.`}
                </Text>
                <View style={{ height: 8, borderRadius: 4, backgroundColor: BORDER_GRAY, overflow: "hidden" }}>
                  <View
                    style={{
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: NAVY,
                      width: `${Math.min(
                        100,
                        Math.round(
                          (100 * personalization.flat_progress_m) /
                            Math.max(1, personalization.flat_target_m),
                        ),
                      )}%`,
                    }}
                  />
                </View>
                <Text style={{ fontSize: 12, color: TEXT_GRAY, marginTop: 10 }}>
                  수집 세션 {personalization.session_count}회 · 구간 관측 {personalization.total_samples}건
                </Text>
              </View>
            </View>
          )}

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>경사도별 소요 시간</Text>
              <Text style={styles.sectionDesc}>구간 난이도 기준</Text>
            </View>

            <View style={styles.slopeCard}>
              {SLOPE_ZONES.map((zone) => (
                <SlopeBar
                  key={zone.key}
                  emoji={zone.emoji}
                  label={zone.label}
                  ms={slopeMs[zone.key]}
                  maxMs={maxSlopeMs}
                  color={zone.color}
                />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>지난 경로</Text>
            </View>

            {routes.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyIcon}>🗺</Text>
                <Text style={styles.emptyTitle}>아직 안내된 경로가 없어요</Text>
                <Text style={styles.emptyDesc}>
                  길찾기를 완료하면 이곳에 기록이 표시됩니다.
                </Text>
              </View>
            ) : (
              routes.map((record) => (
                <RouteCard key={record.id} record={record} />
              ))
            )}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
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

  scroll: {
    flex: 1,
  },

  scrollContent: {
    paddingTop: 18,
    paddingBottom: 50,
  },

  profileCard: {
    backgroundColor: NAVY,
    borderRadius: 26,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
    ...shadowStyle,
  },

  profileIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 15,
  },

  profileEmoji: {
    fontSize: 28,
  },

  profileTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: WHITE,
  },

  profileDesc: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: "rgba(255,255,255,0.74)",
    fontWeight: "600",
  },

  section: {
    marginBottom: 18,
  },

  sectionHeader: {
    marginBottom: 10,
  },

  sectionTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: TEXT,
  },

  sectionDesc: {
    marginTop: 4,
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "600",
  },

  statsGrid: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },

  statChip: {
    flex: 1,
    backgroundColor: WHITE,
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  statValue: {
    fontSize: 18,
    fontWeight: "900",
    color: NAVY,
  },

  statLabel: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: "800",
    color: TEXT_GRAY,
  },

  slopeCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 16,
    ...shadowStyle,
  },

  slopeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
  },

  slopeIconBox: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },

  slopeEmoji: {
    fontSize: 20,
  },

  slopeInfo: {
    flex: 1,
  },

  slopeLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 7,
  },

  slopeName: {
    fontSize: 14,
    fontWeight: "900",
    color: TEXT,
  },

  slopeRange: {
    marginLeft: 7,
    fontSize: 12,
    fontWeight: "700",
    color: TEXT_MUTE,
  },

  slopeBarBg: {
    height: 8,
    borderRadius: 999,
    backgroundColor: LIGHT_GRAY,
    overflow: "hidden",
  },

  slopeBarFill: {
    height: "100%",
    borderRadius: 999,
  },

  slopeTime: {
    width: 56,
    textAlign: "right",
    fontSize: 12,
    fontWeight: "900",
    color: TEXT_GRAY,
    marginLeft: 10,
  },

  routeCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    flexDirection: "row",
    overflow: "hidden",
    marginBottom: 14,
    ...shadowStyle,
  },

  routeCardBar: {
    width: 5,
  },

  routeCardBody: {
    flex: 1,
    padding: 16,
  },

  routeCardTop: {
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

  durationChip: {
    marginLeft: 8,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  durationText: {
    fontSize: 11,
    color: TEXT_GRAY,
    fontWeight: "800",
  },

  dateText: {
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

  ratingRow: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
  },

  ratingLabel: {
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "800",
    marginRight: 9,
  },

  starsRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  star: {
    fontSize: 20,
    color: BORDER_GRAY,
    marginHorizontal: 1,
  },

  starFilled: {
    color: C.warn,
  },

  ratingNum: {
    fontSize: 12,
    color: C.warn,
    fontWeight: "900",
  },

  noRating: {
    fontSize: 12,
    color: TEXT_MUTE,
    fontWeight: "700",
  },

  cardArrow: {
    alignSelf: "center",
    paddingRight: 14,
    fontSize: 25,
    color: TEXT_MUTE,
    fontWeight: "700",
  },

  emptyCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 28,
    alignItems: "center",
    ...shadowStyle,
  },

  emptyIcon: {
    fontSize: 54,
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
});