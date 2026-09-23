import React, { useCallback, useMemo, useState } from "react";
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
import { goHome } from "../utils/navigation";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { C, ZONE_COLORS } from "../constants/colors";
import RouteMapView, { type MapCoordinate, type MapRoute, type MapRouteSegment } from "./route/RouteMapView";
import {
  getRoutes,
  deleteRoute,
  formatDuration,
  RouteRecord,
  SegmentTime,
} from "../utils/storage";
import { classifySlopeZone, type SlopeZoneKey } from "../utils/slopeZone";
import { getAuthToken, deleteUserRoute } from "../api";
import { getRouteMeasurements, type RouteMeasurementSegment } from "../api/routeMeasurements";
import { getSegmentHardshipFeedback, getSlowSegments } from "../api/slowSegments";

const NAVY = "#1B0F4A";
const WHITE = "#FFFFFF";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT = "#111111";
const TEXT_GRAY = "#666666";
const TEXT_MUTE = "#9A9A9A";

// 객관적 경사 분류 — 안내 중 지도 색(ZONE_COLORS)·마이페이지와 동일한 유형별
// 4단계(utils/slopeZone.ts classifySlopeZone)로 통일. 예전엔 이 화면만 고정
// 2%/5% 3단계(평지/완만/급경사, getSlopeEffort)를 따로 써서 안내 중 색과 안
// 맞았다. 표정 이모지를 안 쓰는 이유(주관 D 신호 VERDICT_CONFIG와 혼동 방지)는
// 그대로 유지 — 여긴 아이콘만 쓴다.
const EFFORT_CONFIG: Record<SlopeZoneKey, { label: string; color: string; bg: string; icon: string }> = {
  flat: {
    label: "평지",
    color: C.success,
    bg: "#E8F8F5",
    icon: "―",
  },
  optimal: {
    label: "완만",
    color: C.warn,
    bg: "#FFF8E6",
    icon: "╱",
  },
  warning: {
    label: "주의",
    color: "#FF9800",
    bg: "#FFF1E0",
    icon: "▲",
  },
  forbidden: {
    label: "금지",
    color: C.danger,
    bg: "#FFF0F0",
    icon: "⚠",
  },
};

// "걸은 경로" 지도 — ljy(ando-FE 0ef382e) 경로 상세 지도를 이 화면 구조에 맞춰 이식.
// 좌표는 서버 실측(navigation_measurements start/end_coords, [lon,lat]) 우선, 없으면
// 로컬 기록(record.segments start/end). 색은 위 요약 카드와 같은 classifySlopeZone
// 기준이고, 연속된 같은 zone 구간은 하나로 묶어 선이 잘게 끊기지 않게 한다.
type ZonedSeg = { start: MapCoordinate; end: MapCoordinate; slopePercent: number };

function toCoord(c: [number, number] | null | undefined): MapCoordinate | null {
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return { latitude: c[1], longitude: c[0] };
}

function buildWalkedMapRoute(
  raw: RouteMeasurementSegment[],
  local: SegmentTime[],
  walkerType?: string,
): MapRoute | null {
  let segs: ZonedSeg[] = raw.flatMap((s) => {
    const start = toCoord(s.start_coords);
    const end = toCoord(s.end_coords);
    return start && end ? [{ start, end, slopePercent: s.slope_pct }] : [];
  });
  if (segs.length === 0) {
    segs = local.flatMap((s) =>
      s.start && s.end ? [{ start: s.start, end: s.end, slopePercent: s.slopePercent }] : []
    );
  }

  const groups: (MapRouteSegment & { zone: SlopeZoneKey })[] = [];
  segs.forEach((s) => {
    const zone = classifySlopeZone(s.slopePercent, walkerType);
    const last = groups[groups.length - 1];
    if (last && last.zone === zone) {
      last.coordinates.push(s.end);
    } else {
      groups.push({ coordinates: [s.start, s.end], color: ZONE_COLORS[zone] ?? ZONE_COLORS.flat, zone });
    }
  });

  const coordinates = groups.flatMap((g) => g.coordinates);
  if (coordinates.length < 2) return null;
  return { id: "record", color: C.primary, coordinates, segments: groups };
}

// 주관적 D 신호(segment_hardship_feedback.verdict, 사용자가 실제로 답한 것만) —
// EFFORT_CONFIG와 라벨·색·아이콘 계열을 완전히 분리한다. 표정 이모지를 여기만
// 쓰는 이유는 위 주석 참고. 답 안 한 구간은 아예 안 뜬다(빈칸).
const VERDICT_CONFIG: Record<number, { label: string; color: string; bg: string; icon: string }> = {
  [1]:  { label: "편했어요",   color: C.success, bg: "#E8F8F5", icon: "😊" },
  [0]:  { label: "보통이었어요", color: C.warn,    bg: "#FFF8E6", icon: "😐" },
  [-1]: { label: "힘들었어요",  color: C.danger,  bg: "#FFF0F0", icon: "😣" },
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

function SlopeBar({ slope, walkerType }: { slope: number; walkerType?: string }) {
  const absSlope = Math.abs(Number(slope) || 0);
  const capped = Math.min(absSlope, 10);
  const zone = classifySlopeZone(slope, walkerType);
  const cfg = EFFORT_CONFIG[zone];

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

function SegmentRow({
  seg,
  index,
  verdict,
  walkerType,
}: {
  seg: SegmentTime;
  index: number;
  verdict?: number; // 이 구간에 대한 D 신호 응답(-1/0/1) — 없으면 안 답한 것, 배지 자체를 안 그림
  walkerType?: string;
}) {
  const zone = classifySlopeZone(seg.slopePercent, walkerType);
  const cfg = EFFORT_CONFIG[zone];
  const vcfg = verdict != null ? VERDICT_CONFIG[verdict] : undefined;

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

          <View style={styles.badgeRow}>
            <View style={[styles.effortBadge, { backgroundColor: cfg.bg }]}>
              <Text style={styles.effortIcon}>{cfg.icon}</Text>
              <Text style={[styles.effortLabel, { color: cfg.color }]}>
                {cfg.label}
              </Text>
            </View>

            {vcfg && (
              <View style={[styles.verdictBadge, { backgroundColor: vcfg.bg, borderColor: vcfg.color }]}>
                <Text style={styles.effortIcon}>{vcfg.icon}</Text>
                <Text style={[styles.effortLabel, { color: vcfg.color }]}>
                  {vcfg.label}
                </Text>
              </View>
            )}
          </View>
        </View>

        <SlopeBar slope={seg.slopePercent} walkerType={walkerType} />
      </View>

      <View style={styles.segTime}>
        <Text style={styles.segTimeText}>{formatDuration(seg.elapsedMs)}</Text>
      </View>
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
          onPress={goHome}
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
  const [displaySegments, setDisplaySegments] = useState<SegmentTime[]>([]);
  // getRouteMeasurements 원본(좌표 포함) — "구간 설문조사"(나중에 평가) 진입 시
  // 지도를 그리려면 필요하다. displaySegments(SegmentTime)는 좌표가 없는 화면
  // 표시 전용 타입이라 별도로 들고 있는다. 로컬 폴백일 땐 빈 배열(지도 없음).
  const [rawMeasurements, setRawMeasurements] = useState<RouteMeasurementSegment[]>([]);
  const [dataSource, setDataSource] = useState<"server" | "local">("local");
  const [verdictBySegIndex, setVerdictBySegIndex] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  // 구간 설문조사 대상 존재 여부 — null: 아직 모름(조회 실패 포함, 버튼은 기존처럼
  // 보여준다/막지 않는다), true: 물어볼 구간 있음, false: eligible:false(대부분
  // 평지 등) — 버튼 대신 안내 문구로 바꾼다. "왜 안 뜨는지 드러낸다" 원칙.
  const [slowEligible, setSlowEligible] = useState<boolean | null>(null);

  // 매 렌더마다 새 객체를 넘기면 RouteMapView WebView가 다시 그려져 깜빡이므로 메모.
  const walkedMapRoute = useMemo(
    () => (record ? buildWalkedMapRoute(rawMeasurements, record.segments ?? [], record.walkerType) : null),
    [record, rawMeasurements]
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;

      async function load() {
        setLoading(true);

        const routes = await getRoutes();
        const found = routes.find((r) => r.id === routeId) ?? null;

        // 서버 데이터(navigation_measurements) 우선 — 동의·서버 저장 성공한
        // 실측만 담겨 있어 로컬(record.segments)보다 신뢰도가 높다. serverRouteId가
        // 없거나(동의 안 함/서버 라운드트립 실패) 조회 자체가 실패하거나 빈
        // 배열이면(동의 안 함/서버 저장 실패) 로컬로 폴백 — 기록이 아예 안 보이는
        // 것보다는 낫다는 판단(§RouteDetailScreen 데이터소스 결정).
        let segments: SegmentTime[] = found?.segments ?? [];
        let source: "server" | "local" = "local";
        let verdictMap: Record<number, number> = {};
        let eligible: boolean | null = null;
        if (found?.serverRouteId != null) {
          try {
            const token = await getAuthToken();
            if (token) {
              const resp = await getRouteMeasurements(found.serverRouteId, token);
              if (resp.segments.length > 0) {
                segments = resp.segments.map((s) => ({
                  index:        s.index,
                  distanceM:    s.distance_m,
                  slopePercent: s.slope_pct,
                  elapsedMs:    s.elapsed_ms,
                  measured:     true,
                }));
                source = "server";
                if (active) setRawMeasurements(resp.segments);

                // D 신호(주관 평가) — seg_index가 unit_index라 서버 소스일 때만
                // 안전하게 매칭된다(로컬 폴백은 raw edge 인덱스라 아예 안 불러옴).
                // 실패해도 조용히 무시 — 이 화면의 핵심은 객관 데이터, D 신호는
                // 보조 표시일 뿐이라 실패로 나머지를 막을 이유가 없다.
                try {
                  const hf = await getSegmentHardshipFeedback(found.serverRouteId, token);
                  hf.answers.forEach((a) => { verdictMap[a.seg_index] = a.verdict; });
                } catch (e) {
                  console.log("[FE] segment-hardship-feedback(get) 조회 실패 (무시):", e);
                }

                // "구간 설문조사" 버튼을 보여줄지 판단 — eligible:false(대부분 평지라
                // 물어볼 구간 없음)면 버튼 대신 안내 문구로 바꾼다. 조회 자체가
                // 실패하면 null로 남겨 기존처럼 버튼을 보여준다(모름 ≠ 없음).
                try {
                  const ss = await getSlowSegments(found.serverRouteId, token, { retry: false });
                  eligible = ss.eligible === true;
                } catch (e) {
                  console.log("[FE] slow-segments eligibility 조회 실패 (무시):", e);
                }
              }
            }
          } catch (e) {
            console.log("[FE] navigation_measurements 조회 실패 (로컬로 대체):", e);
          }
        }

        if (active) {
          setRecord(found);
          setDisplaySegments(segments);
          setDataSource(source);
          setVerdictBySegIndex(verdictMap);
          setSlowEligible(eligible);
          setLoading(false);
        }
      }

      load();

      return () => {
        active = false;
      };
    }, [routeId])
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

  const segments = displaySegments;

  const totalDistance = segments.reduce(
    (sum, seg) => sum + (seg.distanceM ?? 0),
    0
  );

  const walkerType = record.walkerType;

  const flatCount = segments.filter(
    (s) => classifySlopeZone(s.slopePercent, walkerType) === "flat"
  ).length;

  const optimalCount = segments.filter(
    (s) => classifySlopeZone(s.slopePercent, walkerType) === "optimal"
  ).length;

  const warningCount = segments.filter(
    (s) => classifySlopeZone(s.slopePercent, walkerType) === "warning"
  ).length;

  const forbiddenCount = segments.filter(
    (s) => classifySlopeZone(s.slopePercent, walkerType) === "forbidden"
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

        <View style={styles.mapCard}>
          <Text style={styles.cardTitle}>걸은 경로</Text>
          <Text style={styles.cardDesc}>구간별 경사도를 색으로 표시했어요.</Text>
          {walkedMapRoute ? (
            <View style={styles.mapBox}>
              <RouteMapView
                routes={[walkedMapRoute]}
                selectedRouteId="record"
                startLabel={record.from || "출발지"}
                endLabel={record.to || "도착지"}
              />
            </View>
          ) : (
            <View style={styles.noMapBox}>
              <Text style={styles.noMapText}>
                {segments.length === 0
                  ? "저장된 구간 정보가 없습니다."
                  : "이 경로는 좌표가 저장되지 않아 지도를 표시할 수 없어요."}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.effortSummaryCard}>
          <Text style={styles.cardTitle}>구간별 난이도 요약</Text>
          <Text style={styles.cardDesc}>경사도 기준으로 구간을 분류했어요.</Text>

          <View style={styles.effortSummaryRow}>
            {[
              { effort: "flat" as const, count: flatCount },
              { effort: "optimal" as const, count: optimalCount },
              { effort: "warning" as const, count: warningCount },
              { effort: "forbidden" as const, count: forbiddenCount },
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
          <Text style={styles.cardDesc}>
            {dataSource === "server"
              ? "서버에 저장된 실측 기록 · 경사도 기준 난이도"
              : "이 기기에 저장된 기록 · 경사도 기준 난이도"}
          </Text>

          {segments.length === 0 ? (
            <View style={styles.noSegmentBox}>
              <Text style={styles.noSegmentText}>저장된 구간 정보가 없습니다.</Text>
            </View>
          ) : (
            segments.map((seg, index) => (
              <React.Fragment key={`${seg.index ?? index}-${index}`}>
                <SegmentRow seg={seg} index={index} verdict={verdictBySegIndex[seg.index]} walkerType={walkerType} />
                {index < segments.length - 1 && (
                  <View style={styles.segDivider} />
                )}
              </React.Fragment>
            ))
          )}
        </View>

        {dataSource === "server" && record.serverRouteId != null && slowEligible === false && (
          <View style={styles.surveyCardDisabled}>
            <View style={{ flex: 1 }}>
              <Text style={styles.surveyTitleMuted}>구간 설문조사</Text>
              <Text style={styles.surveyDesc}>
                이 경로는 실측된 구간이 없어 평가할 내용이 없어요.
              </Text>
            </View>
          </View>
        )}

        {dataSource === "server" && record.serverRouteId != null && slowEligible !== false && (
          <TouchableOpacity
            style={styles.surveyCard}
            activeOpacity={0.85}
            onPress={() => {
              // 좌표 있는 unit만 골라 unit_index 위치를 그대로 보존한 채(희소
              // 배열) 넘긴다 — SlowSegmentFeedbackScreen이 measurementUnits[seg_index]로
              // 직접 인덱싱하므로 순서를 압축하면 엉뚱한 구간을 가리키게 된다.
              // 이 컬럼(start/end 위경도) 추가 이전에 걸은 경로는 전부 null이라
              // 지도 없이(hasMap=false) 텍스트만 폴백 — 기존과 동일하게 동작.
              const withCoords = rawMeasurements.filter((s) => s.start_coords && s.end_coords);
              const maxIdx = rawMeasurements.reduce((m, s) => Math.max(m, s.index), -1);
              const measurementUnits: (Record<string, unknown> | null)[] = new Array(maxIdx + 1).fill(null);
              withCoords.forEach((s) => {
                measurementUnits[s.index] = {
                  unit_index: s.index, distance_m: s.distance_m, slope_pct: s.slope_pct,
                  coord_start_idx: s.index, coord_end_idx: s.index + 1,
                  start_coords: s.start_coords, end_coords: s.end_coords,
                };
              });
              const routeSegments = withCoords.map((s) => ({
                start: { latitude: s.start_coords![1], longitude: s.start_coords![0] },
                end:   { latitude: s.end_coords![1],   longitude: s.end_coords![0] },
                slope_pct: s.slope_pct,
                length_m:  s.distance_m,
              }));

              router.push({
                pathname: "/slow-segment-feedback",
                params: {
                  serverRouteId: String(record.serverRouteId),
                  nextRouteId: routeId,
                  ...(withCoords.length > 0
                    ? {
                        measurementUnits: JSON.stringify(measurementUnits),
                        routeSegments:    JSON.stringify(routeSegments),
                      }
                    : {}),
                },
              });
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.surveyTitle}>구간 설문조사</Text>
              <Text style={styles.surveyDesc}>
                {Object.keys(verdictBySegIndex).length > 0
                  ? "답변을 더 하거나 수정할 수 있어요."
                  : "느린 구간이 어땠는지 나중에 평가할 수 있어요."}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={NAVY} />
          </TouchableOpacity>
        )}

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

  mapCard: {
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    marginBottom: 18,
    ...shadowStyle,
  },

  mapBox: {
    marginTop: 14,
    height: 320,
    borderRadius: 18,
    overflow: "hidden",
  },

  noMapBox: {
    marginTop: 14,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 16,
    padding: 18,
    alignItems: "center",
  },

  noMapText: {
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "800",
    textAlign: "center",
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

  surveyCard: {
    marginTop: 18,
    backgroundColor: WHITE,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    ...shadowStyle,
  },

  surveyTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: TEXT,
  },

  surveyCardDisabled: {
    marginTop: 18,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
  },

  surveyTitleMuted: {
    fontSize: 15,
    fontWeight: "900",
    color: TEXT_MUTE,
  },

  surveyDesc: {
    marginTop: 4,
    fontSize: 12.5,
    color: TEXT_GRAY,
    fontWeight: "600",
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
    flexWrap: "wrap",
    rowGap: 6,
    marginBottom: 8,
  },

  segDistance: {
    fontSize: 13,
    fontWeight: "900",
    color: TEXT,
    flex: 1,
  },

  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  effortBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },

  // D 신호(주관 평가) 배지 — effortBadge(경사, 채워진 배경)와 시각적으로 다르게
  // 테두리형으로 구분한다. "객관 경사와 나란히 놓여도 헷갈리지 않게"가 목적.
  verdictBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1.5,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
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