import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Alert,
  Linking,
  AppState,
} from "react-native";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
// expo-speech: npx expo install expo-speech 실행 필요 (미설치 시 TTS 비활성)
let Speech: {
  speak: (text: string, options?: Record<string, unknown>) => void;
  stop:  () => void;
} = {
  speak: () => {},
  stop:  () => {},
};
try { Speech = require("expo-speech"); } catch {}
import { C, ZONE_COLORS } from "../constants/colors";
import {
  saveRoute,
  updateServerRouteId,
  generateId,
  RouteRecord,
  SegmentTime,
  getShowSlopeMarkers,
  formatMinutes,
} from "../utils/storage";
import { classifySlopeZone } from "../utils/slopeZone";
import { ZOOM_LINE_SCALE_JS } from "../utils/mapLineScale";
import { createRouteProgressTracker } from "../utils/routeProgress";
import {
  getAuthToken,
  startNavigation,
  submitSegment,
  completeNavigation,
  type MeasurementSegmentPayload,
} from "../api";
import type { NavSegment, Waypoint, MeasurementUnit } from "../api/routeApi";
import { CollectSession, drainCollectQueue } from "../utils/collectQueue";
import { startCollectSession, reportGpsFixStage, type SlopeObservation } from "../api/collect";
import { StepTracker } from "../utils/stepTracker";
import {
  classifyElapsed,
  computeVStop,
  type GpsFix as StopClassifierGpsFix,
} from "../utils/stopClassifier";
import { GpsTraceBuffer } from "../utils/gpsTraceBuffer";
import { binCenter } from "../utils/slopeBinTracker";
import { DistanceRowTracker, type DistanceRowObservation, type SlopeSource } from "../utils/distanceRowTracker";
import {
  SPEED_SAMPLE_MAX_GAP_S,
  IMPLIED_SPEED_JUMP_MPS,
  JUMP_ACCURACY_MAX_M,
  NEAR_STOP_SPEED_MS,
  GPS_ACCURACY,
  GPS_TIME_INTERVAL_MS,
  GPS_DISTANCE_INTERVAL_M,
  FIRST_FIX_TIMEOUT_S,
  GPS_ACCURACY_FALLBACK_1,
  GPS_ACCURACY_FALLBACK_2,
} from "../personalization/config";
import { useKeepAwake } from "expo-keep-awake";
import { routeAfterRating } from "../personalization/entry";
import { APP_VERSION, MEASUREMENT_SCHEMA_VERSION } from "../personalization/config";
import RoundtripHintBanner from "../personalization/RoundtripHintBanner";
import { getCollectConsent, setCollectConsent } from "../personalization/collectConsent";
import CollectConsentModal from "../personalization/CollectConsentModal";

const KAKAO_JAVASCRIPT_KEY = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY;

const MODE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  walk:    { icon: "🚶", label: "도보 안내",     color: C.primary },
  transit: { icon: "🚌", label: "대중교통 안내", color: C.subway  },
  car:     { icon: "🚗", label: "자동차 안내",   color: C.car     },
};

const TURN_ICONS: Record<string, string> = {
  "직진":  "↑",
  "우회전": "→",
  "좌회전": "←",
  "유턴":  "↩",
};

type Coordinate = {
  latitude: number;
  longitude: number;
};

type RouteSegment = {
  start: Coordinate;
  end: Coordinate;
  slope: number;
  length?: number;
  direction?: string;
  name?: string;
  zone?: string;
  // 하이브리드(서울 밖) 직선 구간 — 경사 데이터 없음.
  // 소요시간 측정·구간 피드백·신호 A/D 판단에서 제외한다(중도 종료 구간과 동일 취급).
  outsideSeoul?: boolean;
  // S6.5 — OSM 원본 highway=='steps' 태그 기반 사실 필드(경사 추정 아님).
  is_stairs?: boolean;
  // S6 — slope 0/NULL/교량 구분(routing/graph.py 참고).
  slope_source?: SlopeSource;
};

// slopeMean/zone 추가 — 오르막/내리막 화살표 표시용
type NavSegData = { startIdx: number; endIdx: number; color: string; slopeMean: number; zone: string };

interface Props {
  navigation: any;
  route?: {
    params?: {
      routeId?: string;
      mode?: string;
      from?: string;
      to?: string;
      walkerType?: string;
      routeData?: string;
      startLatitude?: string;
      startLongitude?: string;
      endLatitude?: string;
      endLongitude?: string;
      // 대중교통 모드 전용: 이 구간(도보) 다음에 이어질 구간 정보. walk 모드에서는 사용하지 않음.
      transitNextLeg?: string;
      // 개인화 계측 세션 ID. 3경로 비교 화면(⑬)에서 경로 선택을 먼저 기록한 뒤
      // 같은 세션으로 안내 계측을 이어붙이기 위해 넘긴다. 없으면 새로 생성.
      collectSessionId?: string;
      // 대중교통 leg 전환 시, 이전 leg의 CollectSession이 이미 쓴 seq 다음 값을
      // 이어받는다. 없으면 CollectSession이 0부터 시작 — collectSessionId를
      // 재사용하면서 이 값을 안 넘기면, 이전 leg가 이미 쓴 (uid,session_id,seq)와
      // 겹쳐 백엔드 ON CONFLICT DO NOTHING에 조용히 씹힌다(leg 전환 세션 단절 버그).
      collectSessionStartSeq?: number;
      // GpsTraceBuffer(측정 파이프라인 v2 원본 궤적)의 seq는 CollectSession과
      // 별개 카운터라 따로 이어받아야 한다 — 안 넘기면 gps_traces도 같은
      // (session_id, seq) 충돌로 leg 2+ 포인트가 조용히 유실된다.
      gpsTraceStartSeq?: number;
      // 상단 여정 스테퍼용 — 전체 구간 요약(JSON 배열)과 그중 지금 안내 중인 인덱스.
      journeySteps?: string;
      legIndex?: string;
      // 지금 안내 중이지 않은 나머지 구간까지 포함한 전체 여정 좌표(옅은 참고선용)
      journeyMapPath?: string;
      // 구간별로 나눠 보여주지 않고 전체 여정을 한 번에 색칠해서 보여주기 위한
      // 구간별 색상 데이터(경사도 zone / 노선색) — 미리보기 지도와 동일한 형식.
      journeyMapSegments?: string;
      // 대중교통 모드 전용: 사용자가 입력한 진짜 최종 목적지. "to"는 지금 안내
      // 중인 도보 leg의 끝점(승차/환승 지점)이라 최종 목적지와 다를 수 있다.
      finalDestinationName?: string;
      // 도보 탭: 도착지가 역이면 서버가 고른 보행약자용 출구 문구
      stationExitMessage?: string;
      // 대중교통 모드 전용: 사용자가 입력한 진짜 출발지. "from"은 도보2 구간
      // 등에서 하차/환승 지점일 수 있어 진짜 출발지와 다를 수 있다.
      finalOriginName?: string;
    };
  };
}

function safeParseRouteData(routeData?: string) {
  if (!routeData) return null;
  try {
    return JSON.parse(routeData);
  } catch {
    return null;
  }
}

function normalizeCoordinates(raw: any): Coordinate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (Array.isArray(item) && item.length >= 2) {
        return { latitude: Number(item[1]), longitude: Number(item[0]) };
      }
      return {
        latitude:  Number(item.latitude ?? item.lat ?? item.y),
        longitude: Number(item.longitude ?? item.lon ?? item.lng ?? item.x),
      };
    })
    .filter(
      // 여기서 좌표를 제거하면 navigation_segments의 coord_start_idx/coord_end_idx가
      // (백엔드가 계산한) 원본 좌표 배열 기준 인덱스이므로 이후 모든 구간이
      // 밀려서 어긋난다 — 그래서 유효성(NaN)만 거르고 지리적 범위로는 거르지 않는다.
      (c: Coordinate) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude)
    );
}

function normalizeSegments(raw: any): RouteSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((seg: any) => ({
      start: {
        latitude:  Number(seg.start?.latitude ?? seg.start?.lat ?? seg.start?.y),
        longitude: Number(seg.start?.longitude ?? seg.start?.lon ?? seg.start?.lng ?? seg.start?.x),
      },
      end: {
        latitude:  Number(seg.end?.latitude ?? seg.end?.lat ?? seg.end?.y),
        longitude: Number(seg.end?.longitude ?? seg.end?.lon ?? seg.end?.lng ?? seg.end?.x),
      },
      slope:     Number(seg.slope ?? seg.slope_pct ?? 0),
      length:    Number(seg.length ?? seg.length_m ?? 0),
      direction: seg.direction ?? "flat",
      name:      seg.name ?? "",
      zone:      seg.zone ?? undefined,
      // 하이브리드(서울 밖) 직선 구간 — 경사 데이터 없음. 다운스트림(경사색·신호 D)이
      // slope=0 을 실측값으로 오인하지 않도록 표식만 넘긴다.
      outsideSeoul: seg.outside_seoul === true,
      // 버그 수정(S6): 이 필드들이 raw→RouteSegment 변환에서 누락돼 있었다 —
      // is_stairs는 S6.5부터 타입 선언만 있고 여기서 복사가 안 돼 완성 세그먼트
      // 시점(§1479)엔 항상 undefined(=false)였다(계단 facility 판정이 신호 A에서
      // 죽어 있었음). slope_source는 S6 신규 필드.
      is_stairs: seg.is_stairs === true,
      slope_source: (seg.slope_source as SlopeSource | undefined) ?? "missing",
    }))
    .filter(
      (s: RouteSegment) =>
        Number.isFinite(s.start.latitude) && Number.isFinite(s.start.longitude) &&
        Number.isFinite(s.end.latitude)   && Number.isFinite(s.end.longitude)
    );
}

function isLocationNearRoute(location: Coordinate | null, coordinates: Coordinate[]) {
  if (!location || coordinates.length === 0) return false;
  const lats = coordinates.map((c) => c.latitude);
  const lons  = coordinates.map((c) => c.longitude);
  const margin = 0.02;
  return (
    location.latitude  >= Math.min(...lats) - margin &&
    location.latitude  <= Math.max(...lats) + margin &&
    location.longitude >= Math.min(...lons) - margin &&
    location.longitude <= Math.max(...lons) + margin
  );
}

// navSegData(백엔드 navigation_segments, classify_zone 결과)가 비어있을 때만
// 쓰는 폴백 — 하이브리드/DEM 커버리지 밖 구간 등(§도보 안내 지도 렌더 분기,
// ":518-550" 부근 navSegs/segmentData 우선순위 참고). 예전엔 유형과 무관하게
// 고정 ±3%/±8%(구식 3%/8% 폴백, 커밋 14169cf에서 언급된 그 코드)를 써서, 예를
// 들어 walker(워커)의 내리막처럼 g_opt=0%인 유형은 0~3% 내리막이 실제로는
// "주의"인데 화면에는 "완만" 초록으로 뜨는 불일치가 있었다. backend/routing/cost.py
// USER_TYPES(g_opt/g_warn)를 그대로 복제해 classify_zone과 동일한 판정 후
// ZONE_COLORS로 칠한다. 분류 로직(유형별 g_opt/g_warn 임계값)은 마이페이지·
// 경로상세와 공유하는 utils/slopeZone.ts로 이전 — 예전엔 이 파일에만 있어서
// 안내 중 색(4단계 유형별)과 다녀온 뒤 요약(3단계 고정) 분류가 서로 달랐다.
function getSegmentColor(slope: number, walkerType?: string) {
  return ZONE_COLORS[classifySlopeZone(slope, walkerType)] ?? ZONE_COLORS.flat;
}

function formatDistance(distanceM: any) {
  const n = Number(distanceM);
  if (!Number.isFinite(n)) return "거리 정보 없음";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}km` : `${Math.round(n)}m`;
}

const WALK_SPEED_M_S: Record<string, number> = {
  manual_wheelchair:   0.75,
  electric_wheelchair: 1.09,
  walker:              0.80,
  cane:                0.92,
  leg_injury:          0.86,
  elderly:             0.92,
};

function formatTime(
  distanceM: any,
  walkerType?: string,
  estimatedTimeS?: number,
  estimatedTimeMin?: number,
) {
  if (Number.isFinite(estimatedTimeMin) && estimatedTimeMin! > 0) {
    return `약 ${formatMinutes(estimatedTimeMin!)}`;
  }
  if (Number.isFinite(estimatedTimeS) && estimatedTimeS! > 0) {
    return `약 ${formatMinutes(estimatedTimeS! / 60)}`;
  }
  const n = Number(distanceM);
  if (!Number.isFinite(n)) return "시간 정보 없음";
  const speed = WALK_SPEED_M_S[walkerType ?? ""] ?? 1.2;
  return `약 ${formatMinutes(n / speed / 60)}`;
}

function formatSlope(avgSlope: any) {
  const n = Number(avgSlope);
  if (!Number.isFinite(n)) return "경사도 정보 없음";
  return `${n.toFixed(2)}%`;
}

// 2026-09 1단계 완화(15m→25m) — 실기기 미검증, 다음 세션에서 실측 확인 필요.
const PROXIMITY_THRESHOLD = 25;
// routeSegments catch-up 스캔 한도(세그먼트 개수) — 콜백 공백 중 놓친 세그먼트를
// 몇 개까지 앞서 훑어볼지. 실기기 dt 최대 27.7s 관측 기준 도보~가벼운 조깅
// 속도(≤3m/s)로도 최대 ~83m라 5~10m 단위 세그먼트로는 수십 개면 충분히 여유
// 있게 잡은 값(비용은 haversine 계산 몇 번뿐이라 넉넉하게 잡아도 무리 없음).
const SEGMENT_CATCHUP_LOOKAHEAD = 50;
// S0(GPS 수신 간격 개선) — accuracy/timeInterval/distanceInterval을 config
// 상수로 옮김(docs/config_reference.md). ⚠️ 기존엔 Accuracy.High가 "GPS 하드웨어
// 단독 픽스만 기다려서 실내·건물 인근에서 첫 위치가 무한 대기하는 known 이슈"
// 때문에 일부러 Balanced를 썼었다 — BestForNavigation은 High보다도 더 엄격한
// 정확도를 요구해 같은(혹은 더 심한) 인도어 락 지연을 유발할 수 있다. 아래
// gpsWatchdog(8초 메시지)는 지연을 "알려줄" 뿐 정확도를 낮춰 우회하지 않으므로,
// S0 실기기 테스트에서 이 회귀가 재현되는지 반드시 함께 확인할 것.
const GPS_WATCH_OPTIONS = {
  accuracy:         GPS_ACCURACY,
  distanceInterval: GPS_DISTANCE_INTERVAL_M,
  timeInterval:     GPS_TIME_INTERVAL_MS,
};

function haversineDistance(a: Coordinate, b: Coordinate): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const sinHLat = Math.sin(dLat / 2);
  const sinHLon = Math.sin(dLon / 2);
  const x =
    sinHLat * sinHLat +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinHLon * sinHLon;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// navigation_measurements.elapsed_ms P0 수정 — 콜백 수신 시각(now)이 아니라
// 구간 끝점을 실제로 지난 시각을 추정해 쓴다. GPS 콜백 간격이 벌어질수록(중앙값
// 6.9s·p75 12.9s, 실기기 최대 27.7s 관측) "이번 콜백을 받은 시각"과 "실제로 그
// 지점을 지난 시각" 사이 오차가 커져, 마침 그 tick에 unit이 닫히면 그 오차
// 전체가 elapsed_ms에 그대로 실린다(D 랭킹이 이 값을 그대로 쓰므로 신호 대기
// 같은 정지 구간이 "느린 구간 1위"로 잘못 뽑히는 원인 중 하나). 직전 콜백
// 시각(prevTime)·진행률(prevProgressM)과 이번 콜백(currTime·currProgressM) 사이를
// 등속으로 가정해 boundaryArcLength 지점을 지난 시각을 선형보간한다.
function interpolateCrossingTime(
  prevProgressM: number,
  prevTime: number,
  currProgressM: number,
  currTime: number,
  boundaryArcLength: number,
): number {
  // prevTime=0: 세션 첫 콜백(비교 대상 없음). currProgressM<=prevProgressM: 제자리
  // GPS 지터/뒷걸음(트래커는 단조증가만 하므로 이 경우 사실상 "안 움직임") —
  // 두 경우 다 보간 근거가 없어 콜백 수신 시각을 그대로 쓴다(기존 동작과 동일).
  if (!prevTime || currProgressM <= prevProgressM) return currTime;
  const frac = (boundaryArcLength - prevProgressM) / (currProgressM - prevProgressM);
  const clamped = Math.min(1, Math.max(0, frac));
  return prevTime + clamped * (currTime - prevTime);
}

// S3 — 신호 A 행의 device_model. 새 네이티브 모듈(expo-device) 추가 없이
// React Native 코어에 이미 있는 Platform.constants만 쓴다(제조사/모델 확인 —
// 안드로이드 타겟 기준, iOS는 모델명 대신 시스템 버전만 나옴).
function getDeviceModel(): string | null {
  try {
    if (Platform.OS === "android") {
      const c = Platform.constants as { Manufacturer?: string; Model?: string };
      const parts = [c?.Manufacturer, c?.Model].filter(Boolean);
      return parts.length ? parts.join(" ") : null;
    }
    return `iOS ${Platform.Version}`;
  } catch {
    return null;
  }
}

function getZoneKey(zone?: string, direction?: string): string {
  if (!zone || zone === "flat" || !direction || direction === "flat") return "flat";
  const d = direction === "up" ? "up" : "down";
  if (zone === "optimal")   return `${d}_optimal`;
  if (zone === "warning")   return `${d}_warning`;
  if (zone === "forbidden") return `${d}_forbidden`;
  return "flat";
}

function escapeHtmlText(text: string) {
  return text.replace(/'/g, "\\'").replace(/\n/g, " ");
}

// 지도 줌 범위(bounds) 계산 전용 — 렌더링/인덱싱에 쓰는 coordinates 배열은
// 그대로 두고, 여기서만 인접 좌표 간 거리가 비정상적으로 먼(오염된) 좌표를
// 제외한다. 예: 좌표 하나가 잘못 파싱돼 대한해협 건너 일본까지 포함되면서
// 지도가 전체 경로를 담으려고 크게 줌아웃되는 문제를 방지.
function computeRouteBounds(coordinates: Coordinate[]) {
  if (coordinates.length === 0) return null;

  const MAX_STEP_M = 500;
  const sane: Coordinate[] = [];
  for (const c of coordinates) {
    const prev = sane[sane.length - 1];
    if (!prev || haversineDistance(prev, c) <= MAX_STEP_M) {
      sane.push(c);
    }
  }
  const pool = sane.length > 0 ? sane : coordinates;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const c of pool) {
    if (c.latitude  < minLat) minLat = c.latitude;
    if (c.latitude  > maxLat) maxLat = c.latitude;
    if (c.longitude < minLon) minLon = c.longitude;
    if (c.longitude > maxLon) maxLon = c.longitude;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function makeKakaoMapHtml({
  coordinates,
  navSegData,
  routeSegments,
  currentLocation,
  from,
  to,
  showSlopeMarkers,
  journeyMapPath,
  journeyMapSegments,
  finalDestinationName,
  finalOriginName,
  walkerType,
}: {
  coordinates:    Coordinate[];
  navSegData:     NavSegData[];
  routeSegments:  RouteSegment[];
  currentLocation: Coordinate | null;
  from: string;
  to:   string;
  showSlopeMarkers: boolean;
  journeyMapPath: Coordinate[];
  journeyMapSegments: { coordinates: Coordinate[]; color: string }[];
  finalDestinationName: string;
  finalOriginName: string;
  walkerType?: string; // navSegData 비었을 때 폴백(getSegmentColor)의 유형별 색칠용
}) {
  const fallback = coordinates[0] ?? { latitude: 37.5665, longitude: 126.978 };

  const journeyPathJson = JSON.stringify(
    journeyMapPath.map((c) => ({ lat: c.latitude, lng: c.longitude }))
  );

  const journeySegmentsJson = JSON.stringify(
    journeyMapSegments.map((seg) => ({
      path: seg.coordinates.map((c) => ({ lat: c.latitude, lng: c.longitude })),
      color: seg.color,
    }))
  );

  const pathJson = JSON.stringify(
    coordinates.map((c) => ({ lat: c.latitude, lng: c.longitude }))
  );

  const navSegJson = JSON.stringify(
    navSegData.map((s) => ({
      startIdx:  s.startIdx,
      endIdx:    s.endIdx,
      color:     s.color,
      slopeMean: s.slopeMean,
      zone:      s.zone,
    }))
  );

  const routeBounds = computeRouteBounds(coordinates);
  const routeBoundsJson = JSON.stringify(routeBounds);

  const segmentJson = JSON.stringify(
    routeSegments.map((seg) => ({
      start: { lat: seg.start.latitude, lng: seg.start.longitude },
      end:   { lat: seg.end.latitude,   lng: seg.end.longitude   },
      color: getSegmentColor(seg.slope, walkerType),
    }))
  );

  const currentJson = currentLocation
    ? JSON.stringify({ lat: currentLocation.latitude, lng: currentLocation.longitude })
    : "null";

  // 지도 위 "출발"/"도착" 마커는 이 구간(leg)의 경계가 아니라 여정 전체의
  // 진짜 출발지/최종 목적지를 보여줘야 한다 — 대중교통 도보1 구간에서는
  // to가 "승차 지점"이라 도착 마커가 지하철역으로 뜨는 문제가 있었다.
  const safeFrom = escapeHtmlText(finalOriginName || from);
  const safeTo   = escapeHtmlText(finalDestinationName || to);

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
        <style>
          html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; }
          #map { width:100%; height:100%; }
          .label {
            padding:6px 10px; border-radius:14px; background:#fff; color:#1A1A2E;
            font-size:12px; font-weight:700; box-shadow:0 2px 8px rgba(0,0,0,0.16); white-space:nowrap;
          }
          .current-wrap { display:flex; flex-direction:column; align-items:center; }
          .current-dot {
            width:18px; height:18px; border-radius:50%; background:#3478F6;
            border:4px solid white; box-shadow:0 2px 8px rgba(0,0,0,0.3);
          }
          .current-label {
            margin-top:4px; padding:4px 8px; border-radius:12px; background:#3478F6;
            color:#fff; font-size:11px; font-weight:700; white-space:nowrap;
          }
          .slope-arrow {
            font-size:13px; font-weight:900; color:#fff;
            background:rgba(0,0,0,0.55); border-radius:8px;
            padding:2px 5px; white-space:nowrap;
          }
          .legend-toggle {
            position:absolute; right:12px; top:112px; z-index:11; border:none;
            border-radius:999px; padding:9px 13px;
            background:rgba(27,15,74,0.92); color:#fff; font-size:12px;
            font-weight:800; box-shadow:0 2px 8px rgba(0,0,0,0.22);
          }
          .legend {
            position:absolute; right:12px; top:154px;
            background:rgba(20,24,31,0.9); border-radius:14px;
            padding:10px 12px; box-shadow:0 2px 8px rgba(0,0,0,0.22);
            font-size:12px; font-weight:700; color:#fff; z-index:10;
          }
          .hidden { display:none; }
          .legend-title { font-size:12px; color:rgba(255,255,255,0.6); margin-bottom:6px; }
          .legend-row { display:flex; align-items:center; margin-top:6px; white-space:nowrap; }
          .legend-line { width:42px; height:6px; border-radius:5px; margin-right:9px; display:inline-block; }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <button class="legend-toggle" onclick="toggleLegend()">접근성 경로 ⓘ</button>
        <div id="legendBox" class="legend hidden">
          <div class="legend-title">경로 색상 안내</div>
          <div class="legend-row"><span class="legend-line" style="background:#4CAF50"></span>평지 구간</div>
          <div class="legend-row"><span class="legend-line" style="background:#FDD835"></span>완만한 경사</div>
          <div class="legend-row"><span class="legend-line" style="background:#FF9800"></span>주의 구간</div>
          <div class="legend-row"><span class="legend-line" style="background:#F44336"></span>위험 구간</div>
        </div>
        <script type="text/javascript"
          src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&autoload=false">
        </script>
        <script>
          ${ZOOM_LINE_SCALE_JS}
          function toggleLegend() {
            var box = document.getElementById("legendBox");
            if (!box) return;
            box.classList.toggle("hidden");
          }

          kakao.maps.load(function () {
            var container = document.getElementById("map");
            var map = new kakao.maps.Map(container, {
              center: new kakao.maps.LatLng(${fallback.latitude}, ${fallback.longitude}),
              level: 4
            });
            setTimeout(function () { map.relayout(); }, 300);

            var pathData    = ${pathJson};
            var navSegs     = ${navSegJson};
            var segmentData = ${segmentJson};
            var currentData = ${currentJson};
            var routeBounds = ${routeBoundsJson};
            var journeyPath = ${journeyPathJson};
            var journeySegments = ${journeySegmentsJson};

            // FE에서 오염 좌표(예: 대한해협 건너 일본까지 포함되는 경우)를
            // 제외하고 미리 계산한 min/max로 bounds 구성 — 장거리 줌 이슈 수정
            var bounds = routeBounds
              ? new kakao.maps.LatLngBounds(
                  new kakao.maps.LatLng(routeBounds.minLat, routeBounds.minLon),
                  new kakao.maps.LatLng(routeBounds.maxLat, routeBounds.maxLon)
                )
              : new kakao.maps.LatLngBounds();

            // 구간 나눠 보여주지 않고 전체 여정(도보+탑승+도보)을 미리보기 지도와
            // 똑같이 색칠해서 한 번에 보여준다. 지금 GPS로 안내 중인 구간은 이
            // 아래에서 navSegs/segmentData로 한 번 더(더 두껍게) 그려서 강조된다.
            // journeySegments가 없는 도보 전용 모드에서는 옅은 회색 참고선으로 대체.
            if (journeySegments.length > 0) {
              journeySegments.forEach(function (seg) {
                if (!seg.path || seg.path.length < 2) return;
                var segLatLngs = seg.path.map(function (p) {
                  return new kakao.maps.LatLng(p.lat, p.lng);
                });
                // 대중교통 탭 미리보기(RouteMapView)와 같은 테두리+중앙 2중 선 —
                // 탑승(버스/지하철) 구간도 노선색으로 또렷하게 보이게 한다.
                zoomLine(new kakao.maps.Polyline({
                  map: map, path: segLatLngs,
                  strokeWeight: 18, strokeColor: "#7C6FF7",
                  strokeOpacity: 1, strokeStyle: "solid"
                }), 18, 6);
                zoomLine(new kakao.maps.Polyline({
                  map: map, path: segLatLngs,
                  strokeWeight: 13, strokeColor: seg.color || "#9E9E9E",
                  strokeOpacity: 1, strokeStyle: "solid"
                }), 13, 4);
              });
            } else if (journeyPath.length > 1) {
              var journeyLatLngs = journeyPath.map(function (p) {
                return new kakao.maps.LatLng(p.lat, p.lng);
              });
              zoomLine(new kakao.maps.Polyline({
                map: map, path: journeyLatLngs,
                strokeWeight: 4, strokeColor: "#9E9E9E",
                strokeOpacity: 0.5, strokeStyle: "shortdash"
              }), 4, 2);
            }

            // 퍼센트 화살표는 항상 만들어두고 setMap(null/map)으로만 껐다 켰다 한다 —
            // 토글 버튼이 HTML을 통째로 다시 그리지 않고 injectJavaScript로
            // 즉시 반영해야 해서, 나중에 켤 때 다시 계산할 필요가 없게 미리 준비해둔다.
            window.__slopeArrows = [];
            window.setSlopeMarkers = function (enabled) {
              window.__slopeArrows.forEach(function (o) { o.setMap(enabled ? map : null); });
            };

            if (navSegs.length > 0) {
              navSegs.forEach(function(seg) {
                var pts = pathData.slice(seg.startIdx, seg.endIdx + 1);
                if (pts.length < 2) return;
                var polyPath = pts.map(function(p) {
                  return new kakao.maps.LatLng(p.lat, p.lng);
                });
                // 미리보기 지도(RouteMapView)와 동일한 테두리+중앙 2중 렌더링 —
                // 실제 GPS 안내 화면에서도 경로 선을 굵게, 테두리로 눈에 띄게 그린다.
                zoomLine(new kakao.maps.Polyline({
                  path: polyPath, strokeWeight: 18,
                  strokeColor: "#7C6FF7", strokeOpacity: 0.95, strokeStyle: "solid"
                }), 18, 6).setMap(map);
                zoomLine(new kakao.maps.Polyline({
                  path: polyPath, strokeWeight: 13,
                  strokeColor: seg.color, strokeOpacity: 0.95, strokeStyle: "solid"
                }), 13, 4).setMap(map);

                // 오르막/내리막 화살표 — zone이 평지가 아닌 구간에 표시.
                // (slope_mean은 부호로 방향만 판단하고, 절댓값 기준으로
                // 표시 여부를 가르지 않는다 — 백엔드 단위가 %/비율 중
                // 무엇이든 이미 zone 분류가 경사 여부를 반영하고 있음)
                var slope = seg.slopeMean;
                if (seg.zone && seg.zone !== "flat" && slope !== 0 && pts.length >= 2) {
                  var midIdx = Math.floor(pts.length / 2);
                  var midPt  = pts[midIdx];
                  var arrow  = slope > 0 ? "↑" : "↓";
                  var label  = arrow + " " + Math.abs(slope).toFixed(1) + "%";
                  var arrowOverlay = new kakao.maps.CustomOverlay({
                    position: new kakao.maps.LatLng(midPt.lat, midPt.lng),
                    content:  '<div class="slope-arrow">' + label + '</div>',
                    yAnchor:  1.5
                  });
                  window.__slopeArrows.push(arrowOverlay);
                  if (${showSlopeMarkers}) arrowOverlay.setMap(map);
                }
              });
            } else if (segmentData.length > 0) {
              segmentData.forEach(function(seg) {
                var start = new kakao.maps.LatLng(seg.start.lat, seg.start.lng);
                var end   = new kakao.maps.LatLng(seg.end.lat,   seg.end.lng);
                zoomLine(new kakao.maps.Polyline({
                  path: [start, end], strokeWeight: 18,
                  strokeColor: "#7C6FF7", strokeOpacity: 0.95, strokeStyle: "solid"
                }), 18, 6).setMap(map);
                zoomLine(new kakao.maps.Polyline({
                  path: [start, end], strokeWeight: 13,
                  strokeColor: seg.color, strokeOpacity: 0.95, strokeStyle: "solid"
                }), 13, 4).setMap(map);
              });
            } else if (pathData.length > 1) {
              var path = pathData.map(function(p) {
                return new kakao.maps.LatLng(p.lat, p.lng);
              });
              zoomLine(new kakao.maps.Polyline({
                path: path, strokeWeight: 18,
                strokeColor: "#5B52D6", strokeOpacity: 0.95, strokeStyle: "solid"
              }), 18, 6).setMap(map);
              zoomLine(new kakao.maps.Polyline({
                path: path, strokeWeight: 13,
                strokeColor: "#7C6FF7", strokeOpacity: 0.95, strokeStyle: "solid"
              }), 13, 4).setMap(map);
            }

            // 여정 전체 좌표(journeyPath)가 있으면 그 양 끝(진짜 출발지/최종
            // 목적지)을 쓰고, 없는(도보 전용) 모드에서만 현재 leg의 pathData로
            // 대체한다 — 대중교통 도보1 구간에서 pathData 끝점(승차 지점)을
            // "도착"으로 잘못 표시하던 문제를 해결.
            var originPt = journeyPath.length > 0 ? journeyPath[0] : (pathData.length > 0 ? pathData[0] : null);
            var destPt = journeyPath.length > 0 ? journeyPath[journeyPath.length - 1] : (pathData.length > 0 ? pathData[pathData.length - 1] : null);
            if (originPt) {
              new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(originPt.lat, originPt.lng),
                content: '<div class="label">출발 · ${safeFrom}</div>',
                yAnchor: 2.1
              }).setMap(map);
            }
            if (destPt) {
              new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(destPt.lat, destPt.lng),
                content: '<div class="label">도착 · ${safeTo}</div>',
                yAnchor: 2.1
              }).setMap(map);
            }

            // 현재 위치 마커 — GPS가 움직일 때마다 지도를 통째로 다시 그리면
            // (HTML 재생성 → WebView reload) 매번 경로 bounds로 재축소되고
            // 반응도 느려진다. 그래서 이 마커는 bridge(window.updateCurrentLocation)로만
            // 옮기고, mapHtml 자체는 현위치가 바뀌어도 다시 생성하지 않는다.
            var currentOverlay = null;
            function setCurrentOverlay(lat, lng) {
              if (currentOverlay) currentOverlay.setMap(null);
              currentOverlay = new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(lat, lng),
                content:
                  '<div class="current-wrap">' +
                    '<div class="current-dot"></div>' +
                    '<div class="current-label">현재 위치</div>' +
                  '</div>',
                yAnchor: 0.5
              });
              currentOverlay.setMap(map);
            }
            if (currentData) setCurrentOverlay(currentData.lat, currentData.lng);
            window.updateCurrentLocation = function (lat, lng) {
              setCurrentOverlay(lat, lng);
            };

            // 선 굵기를 줌 레벨에 맞춤(축소된 전체 보기에서 과하게 두껍던 문제)
            bindZoomLineWeights(map);

            if (pathData.length > 0) {
              // 패딩(top, bottom, left, right) 충분히 줘서 경로가 화면 안에 들어오게
              setTimeout(function () {
                map.relayout();
                map.setBounds(bounds, 80, 160, 40, 40);
              }, 500);
            }
          });
        </script>
      </body>
    </html>
  `;
}

export default function NavigationScreen({ navigation, route }: Props) {
  // S0(GPS 수신 간격 개선) — 화면이 꺼지면 OS가 GPS 콜백 주기를 늘리므로,
  // 안내 화면이 떠 있는 동안은 화면 꺼짐을 막는다. 마운트 시 활성화, 언마운트
  // (안내 종료·뒤로가기 포함 모든 경로) 시 자동 해제 — 훅 자체가 그렇게 동작한다.
  useKeepAwake();

  const insets = useSafeAreaInsets();

  const routeId    = route?.params?.routeId     ?? "-";
  const mode       = route?.params?.mode         ?? "walk";
  const from       = route?.params?.from         ?? "출발지";
  const to         = route?.params?.to           ?? "도착지";
  const walkerType = route?.params?.walkerType   ?? "manual_wheelchair";
  const routeDataString = route?.params?.routeData ?? "";
  const originLat  = Number(route?.params?.startLatitude)  || null;
  const originLon  = Number(route?.params?.startLongitude) || null;
  const destLat    = Number(route?.params?.endLatitude)    || null;
  const destLon    = Number(route?.params?.endLongitude)   || null;

  // 대중교통 모드에서 "to"는 지금 GPS로 안내 중인 이 도보 leg의 끝점(승차
  // 지점/환승 지점)일 뿐, 사용자가 입력한 진짜 최종 목적지가 아니다. 헤더에는
  // 이걸 따로 받아서 보여준다 — 없으면(도보 전용 모드) to를 그대로 최종
  // 목적지로 취급한다.
  const finalDestinationName = route?.params?.finalDestinationName || to;
  const stationExitMessage = route?.params?.stationExitMessage;
  const finalOriginName = route?.params?.finalOriginName || from;

  useEffect(() => {
    console.log('[NavigationScreen] params 확인 — mode:', mode, '| from:', from,
      '| to(현재 leg 끝점):', to, '| finalDestinationName(최종 목적지):', finalDestinationName,
      '| legIndex:', route?.params?.legIndex, '| journeySteps 개수:',
      safeParseRouteData(route?.params?.journeySteps ?? '')?.length ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cfg = MODE_CONFIG[mode] ?? MODE_CONFIG.walk;

  const routeData = useMemo(() => safeParseRouteData(routeDataString), [routeDataString]);

  // 대중교통 모드에서만 쓰이는, "이 도보 구간 다음에 이어질 구간" 정보 (탑승 안내 + 다음 leg 파라미터)
  const transitNextLeg = useMemo(
    () => safeParseRouteData(route?.params?.transitNextLeg),
    [route?.params?.transitNextLeg]
  );

  // 상단 여정 스테퍼용 — 전체 구간 요약 + 지금 안내 중인 구간 인덱스.
  // TransitContent에서 넘어올 때만 있고, 도보 전용 모드에서는 비어있다.
  const journeySteps: { type: string; icon: string; label: string }[] = useMemo(
    () => safeParseRouteData(route?.params?.journeySteps) ?? [],
    [route?.params?.journeySteps]
  );
  const legIndex = Number(route?.params?.legIndex ?? -1);

  // 지금 GPS로 추적 중인 구간(coordinates) 외에, 전체 여정을 옅은 참고선으로
  // 같이 보여주기 위한 좌표 — 대중교통 안내에서 "환승 이후부터만 보인다"는
  // 체감을 줄이기 위함. 도보 전용 모드에서는 비어있다.
  const journeyMapPath = useMemo(
    () => normalizeCoordinates(safeParseRouteData(route?.params?.journeyMapPath)),
    [route?.params?.journeyMapPath]
  );

  // 구간 나눠 보여주지 않고 전체 여정을 한 번에 색칠해서 보여주기 위한 구간별
  // 색상 데이터 — 있으면 이걸로 전체 경로를 그리고, 없으면(도보 전용 모드)
  // journeyMapPath 참고선으로 대체한다.
  const journeyMapSegments = useMemo(() => {
    const raw = safeParseRouteData(route?.params?.journeyMapSegments) ?? [];
    return (raw as any[]).map((seg) => ({
      coordinates: normalizeCoordinates(seg.coordinates),
      color: seg.color,
    })).filter((seg) => seg.coordinates.length >= 2);
  }, [route?.params?.journeyMapSegments]);

  const coordinates = useMemo(
    () => normalizeCoordinates(routeData?.coordinates),
    [routeData]
  );

  // 대중교통 경로인데 도보 구간이 아예 없어서(버스/지하철만) GPS로 안내할
  // 좌표 자체가 없는 케이스 — TransitContent가 legIndex: '-1'로 표시해서 보낸다.
  const isTransitStub = mode === "transit" && legIndex < 0 && coordinates.length === 0;

  const routeSegments = useMemo(
    () => normalizeSegments(routeData?.routeSegments),
    [routeData]
  );

  const navSegData: NavSegData[] = useMemo(
    () =>
      ((routeData?.navigation_segments ?? []) as NavSegment[]).map((s) => ({
        startIdx:  s.coord_start_idx ?? 0,
        endIdx:    s.coord_end_idx   ?? 0,
        color:     ZONE_COLORS[s.zone] ?? ZONE_COLORS.flat,
        // 백엔드 필드명이 문서와 다를 가능성에 대비한 폴백 체인
        slopeMean: s.slope_mean ?? (s as any).slopeMean ?? (s as any).avg_slope_pct
          ?? (s as any).slope_avg_pct ?? 0,
        zone:      s.zone ?? "flat",
      })),
    [routeData]
  );

  useEffect(() => {
    if (!__DEV__ || navSegData.length === 0) return;
    const nonFlat = navSegData.filter((s) => s.zone !== "flat");
    console.log(
      `[FE] navSegData ${navSegData.length}개 · non-flat ${nonFlat.length}개 · ` +
      `slopeMean 샘플: ${navSegData.slice(0, 5).map((s) => `${s.zone}:${s.slopeMean}`).join(", ")}`
    );
  }, [navSegData]);

  const waypoints: Waypoint[] = useMemo(
    () => (routeData?.waypoints ?? []) as Waypoint[],
    [routeData]
  );

  // 측정 파이프라인 v2 — GPS 실측(submitSegment) 제출 단위. navSegData(지도색)/
  // waypoints(안내문구)/routeSegments(신호 A)와 완전히 별개 배열 — ⑤ 완료:
  // GPS 콜백 안에 unitStartTimesRef/currentUnitIdxRef 기준의 독립된 도착판정
  // 루프가 따로 있다(routeSegments 루프 바로 아래). SlowSegmentFeedbackScreen에도
  // 그대로 전달되어 unit_index 기반 하이라이트에 쓰인다(②, routeAfterRating 경유).
  const measurementUnits: MeasurementUnit[] = useMemo(
    () => (routeData?.measurement_units ?? []) as MeasurementUnit[],
    [routeData]
  );

  // GPS 경로 추종 판정 2단계(2026-09) — 반경(PROXIMITY_THRESHOLD) 판정을 대체하지
  // 않고 보완하는 두 번째 축. coordinates(전체 경로 폴리라인)에 GPS를 투영해
  // "경로 시작 기준 누적 진행 거리"를 추적하고, 그 진행 거리가 어떤 구간/unit의
  // 끝점 위치를 이미 지났으면 그 구간은 통과로 본다 — GPS가 끝점 반경을 못
  // 찍었어도(건물 근처 흔들림, 살짝 비껴 찍음) 실제로 그 지점을 지나왔다면
  // 놓치지 않는다. routeSegments/measurementUnits 루프 양쪽에서 공유해 쓴다.
  const routeProgressTracker = useMemo(
    () => createRouteProgressTracker(coordinates),
    [coordinates]
  );

  const segEndArcLength: number[] = useMemo(
    () => routeSegments.map((seg) => routeProgressTracker.arcLengthOf(seg.end)),
    [routeSegments, routeProgressTracker]
  );

  const unitEndArcLength: number[] = useMemo(
    () =>
      measurementUnits.map((u) => {
        const [endLng, endLat] = u.end_coords;
        return routeProgressTracker.arcLengthOf({ latitude: endLat, longitude: endLng });
      }),
    [measurementUnits, routeProgressTracker]
  );

  useEffect(() => {
    // routeSegments(경로 자체)는 있는데 measurementUnits가 비어 있으면 BE의
    // build_measurement_units가 실패했다는 뜻(app.py가 예외를 삼키고 빈 배열로
    // 응답함) — 안내는 그대로 되지만 navigation_measurements가 0행이라
    // 총 소요시간·느린 구간 피드백이 통째로 빈다. __DEV__ 게이트 없이 남긴다
    // (실기기/배포본에서도 원인 추적 가능해야 함) — 사용자에게는 알리지 않는다.
    // 안내 기능 자체엔 지장이 없고, 이 코드베이스는 이런 부가 데이터 파이프라인
    // 실패를 이미 전부 콘솔 로그 + 무시로 다뤄왔다(백엔드 print, submitSegment
    // catch(()=>{}) 등과 동일 수준 — 사용자를 막는 얼럿을 새로 만들 이유가 없다).
    if (routeSegments.length > 0 && measurementUnits.length === 0) {
      console.warn(
        `[NAV] measurement_units 비어있음(routeSegments ${routeSegments.length}개) — ` +
        `BE build_measurement_units 실패 추정. navigation_measurements 0행 예상.`
      );
    }
  }, [routeSegments.length, measurementUnits.length]);

  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [locationError,   setLocationError]   = useState("");
  const [savedRouteId,    setSavedRouteId]     = useState("");
  // setSavedRouteId 는 비동기(state)라 같은 tick 에 값을 읽는 proceedAfterNavigation
  // 클로저에는 여전히 "" 로 잡힌다 → RouteDetail 이 빈 id 로 조회해 "경로 기록을
  // 찾을 수 없어요" 가 떴다. 종료 핸들러가 만든 id 를 즉시 ref 로도 들고 있는다.
  const savedRouteIdRef = useRef("");
  const [guidance, setGuidance] = useState<{ turn: string; text: string } | null>(null);
  // 안내 종료 여부 — true가 되면 지도(WebView)를 즉시 언마운트해
  // 대용량 좌표/구간 배열 참조를 바로 해제한다 (장거리 경로 종료 지연 대응)
  const [navEnded, setNavEnded] = useState(false);

  const webviewRef = useRef<WebView>(null);

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  useEffect(() => { voiceEnabledRef.current = voiceEnabled; }, [voiceEnabled]);

  // 설정 화면에서 바꾼 값을 그대로 따른다 — 기본은 켜짐.
  const [showSlopeMarkers, setShowSlopeMarkers] = useState(true);
  useEffect(() => { getShowSlopeMarkers().then(setShowSlopeMarkers); }, []);

  // 예상시간/거리/평균경사 정보 카드 — 접근성 경로 범례처럼 기본은 접힌 상태.
  const [showRouteInfo, setShowRouteInfo] = useState(false);

  function speak(text: string) {
    if (!voiceEnabledRef.current || !text) return;
    Speech.stop();
    Speech.speak(text, { language: "ko-KR" });
  }

  const lastAnnouncedZoneRef = useRef<string | null>(null);
  function announceZoneEntry(zoneKey: string | null) {
    if (!zoneKey || zoneKey === lastAnnouncedZoneRef.current) return;
    lastAnnouncedZoneRef.current = zoneKey;

    const upDown = zoneKey.startsWith("up") ? "오르막" : zoneKey.startsWith("down") ? "내리막" : "";
    if (zoneKey.endsWith("_forbidden")) {
      speak(`${upDown} 경사가 매우 심한 구간입니다. 가능하면 우회를 권장합니다.`);
    } else if (zoneKey.endsWith("_warning")) {
      speak(`${upDown} 경사 주의 구간입니다. 천천히 이동하세요.`);
    }
    // flat / optimal 구간은 안내가 잦아지는 것을 막기 위해 발화하지 않음
  }

  // ── 소요시간 측정 refs ──────────────────────────────────────────────────────
  // 구조: GPS가 구간 끝점(seg.end) 15m 이내 진입 시 해당 구간 완료로 판정.
  //   elapsed_ms = 구간 끝점 감지 시각 - segmentStartTimesRef[i]
  //   다음 구간의 시작 시각은 직전 구간 끝 감지 시각으로 자동 연결됨.
  //   measured: true  → GPS 실측값 (ML 학습에 사용)
  //   measured: false → 종료 버튼 시점에 미통과 구간을 거리 비례로 추정한 값
  // BE 전송: 구간 완료 시마다 submitSegment() 실시간 전송 + 종료 시 일괄 전송
  const startTimeRef         = useRef<number>(Date.now());
  const serverRouteIdRef     = useRef<number | null>(null);
  // 종료 시 백그라운드 서버 동기화(completeNavigation 포함) 프로미스. 평가 화면
  // 전환 전에 await 한다 — BE 가 완료 시점에 신호 D 랭킹을 계산하므로.
  const syncPromiseRef       = useRef<Promise<void> | null>(null);
  // collectSessionRef 가 null 로 비워진 뒤에도 살아있는 수집 세션 id (신호 D POST 용).
  const collectSessionIdRef  = useRef<string | null>(null);
  const segmentStartTimesRef = useRef<number[]>([]); // [i] = 구간 i 시작 시각 (ms)
  const currentSegIdxRef     = useRef<number>(0);    // 현재 진행 중인 구간 인덱스
  const measuredMsRef        = useRef<(number | null)[]>([]); // [i] = 구간 i 소요시간, 미측정은 null
  const gpsCallbackCountRef  = useRef<number>(0); // 세그먼트 0 시작 시각 보정용 (2번째 콜백 = 실제 이동 시작)

  // 측정 파이프라인 v2 — submitSegment(BE navigation_measurements) 전용, 위
  // segmentStartTimesRef/currentSegIdxRef(routeSegments=raw edge, 신호 A·안내용)
  // 와 완전히 별개 트래킹이다. measurementUnits(≥30m)는 목적이 다른 별도
  // 분할이라 GPS 도착판정을 독립적으로 다시 돈다 — 하나가 밀려도 다른 하나(신호
  // A)의 해상도에 영향을 주지 않는다. (측정값 자체는 submitSegment 호출 시점에
  // 곧장 서버로 나가 서버 DB가 진실 소스다 — routeSegments 쪽의 measuredMsRef
  // 같은 로컬 보관용 배열은 여기선 필요 없어 두지 않는다.)
  const unitStartTimesRef = useRef<number[]>([]); // [i] = unit i 시작 시각 (ms)
  const currentUnitIdxRef = useRef<number>(0);    // 현재 진행 중인 unit 인덱스
  // ⑥(조기종료 reached_destination 판정) 구현 시 주의: currentUnitIdxRef.current
  // >= measurementUnits.length 로 "도착"을 판정하면, measurementUnits가 빈
  // 배열일 때 0 >= 0 이 참이 되어 BE 실패(위 경고 로그 참고) 케이스를 도착으로
  // 오판한다. measurementUnits.length > 0 && ... 가드를 반드시 먼저 검사할 것.
  // GPS 공백/장시간 점프 직후 닫히는 unit 하나를 오염 처리하기 위한 플래그.
  // 신호 B 블록(dt/거리 임계 초과)과 AppState 백그라운드 복귀 핸들러 양쪽에서
  // true로 세팅되고, unit 루프가 그 다음으로 닫는 unit 하나에 소비한 뒤 리셋한다
  // (SlopeBinTracker.invalidateCurrent와 같은 목적, 별도 트래킹이라 별도 플래그).
  const unitGapPendingRef = useRef<boolean>(false);
  // routeSegments 루프(로컬 SegmentTime — RouteDetailScreen 폴백·MyPageScreen
  // 경사도별 누적시간 통계 둘 다의 소스) 전용 오염 플래그. unitGapPendingRef와
  // 세팅 시점은 항상 같이 가지만(같은 신호 B 판정) 소비·리셋은 이 루프가 독립적으로
  // 한다 — 한 ref를 공유하면 routeSegments 루프가 먼저 소비·리셋해버려 뒤이어
  // 도는 unit 루프가 같은 tick의 진짜 공백을 못 보게 되는 레이스가 생긴다.
  const segGapPendingRef = useRef<boolean>(false);

  // ── 개인화 계측 (인계 §5 ⑪, ando_ml_plan_v2 §3.2 신호 A) ────────────────────
  // zone(3단계 안전 분류) 단위로 뭉치면 경사 축 해상도가 파괴된다(§3.1). S3부터는
  // 0.5% bin 변화가 아니라 고정 거리(ROW_LEN_M=25m)를 경계로 관측 1행씩 만든다
  // — 로직은 DistanceRowTracker(순수 클래스, 단위 검증됨), 이 컴포넌트는 GPS
  // 이벤트만 넣어준다. 전송은 배치만.
  const collectSessionRef = useRef<CollectSession | null>(null);
  const distanceRowTrackerRef = useRef<DistanceRowTracker | null>(null);
  // GPS 원본 궤적(gps_traces) 배치 큐 — 측정 파이프라인 v2. collectSessionRef와
  // 같은 session_id를 쓰고(beginCollection에서 함께 생성) 같은 동의 게이트를
  // 따른다 — 위치 원본이라 신호 A~D보다 민감도가 낮지 않다.
  const gpsTraceBufferRef = useRef<GpsTraceBuffer | null>(null);
  // 신호 B(순간속도) 계산용 — 직전 GPS 픽스
  const lastGpsPosRef   = useRef<Coordinate | null>(null);
  const lastGpsTimeRef  = useRef<number>(0);
  // 앱이 백그라운드로 나간 시각 — 복귀 시 공백이 크면 진행 중이던 bin 을 버린다
  const bgAtRef         = useRef<number>(0);

  // S0 보완 — 정확도 단계별 첫 위치 fallback(BestForNavigation → High → Balanced).
  const firstFixReceivedRef = useRef(false);
  const fallbackTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchStartTimeRef   = useRef(0);
  const gpsFixStageRef      = useRef<string>("best_nav");

  // S1(걸음 수) — 신호 A/B와 같은 동의 게이트(beginCollection)에서 시작, 언마운트 시
  // 반드시 정지. stepsBetween()은 S2(stopClassifier)가 아직 없어 지금은 소비하지
  // 않음 — 센서 구독/해제 생명주기와 null fallback 경로만 이번에 검증한다.
  const stepTrackerRef = useRef<StepTracker | null>(null);

  // S2(stopClassifier) — 최근 GPS 픽스 보관(신호 D 측정단위 판정용). gpsTraceBufferRef
  // 와 별개다: 저건 서버 업로드용 write-only 큐(플러시하면 비워짐), 이건 판정
  // 시점에 "그 구간 동안의 픽스들"을 다시 읽어야 해서 별도로 들고 있는다.
  // CLASSIFY_WINDOW_SEC*몇 배 정도만 있으면 되므로 90초로 넉넉히 자른다.
  const recentFixesRef = useRef<StopClassifierGpsFix[]>([]);
  const RECENT_FIXES_KEEP_MS = 90_000;
  // S3 — 세션 내내 고정값이라 한 번만 계산해 ref에 캐싱.
  const deviceModelRef = useRef<string | null>(getDeviceModel());

  // 개인화 데이터 수집 동의 모달 (이슈 #1). unknown 이고 도보 안내일 때만 뜬다.
  const [consentPrompt, setConsentPrompt] = useState(false);

  /**
   * S3 — DistanceRowObservation(거리/경사 통계만) → 서버 전송용 SlopeObservation
   * (stopClassifier 집계 + 걸음수 + 기기정보까지 채운 완전한 행)으로 변환.
   * recentFixesRef/stepTrackerRef/deviceModelRef는 전부 컴포넌트 스코프 ref라
   * 어느 콜백(GPS 루프, 언마운트 cleanup, handleEndNavigation)에서 불러도 안전.
   */
  const buildSlopeObservationPayload = useCallback(
    (obs: DistanceRowObservation): SlopeObservation => {
      const rowAgg = classifyElapsed(
        recentFixesRef.current,
        obs.start_ms, obs.end_ms,
        computeVStop(null),
        (t0, t1) => stepTrackerRef.current?.stepsBetween(t0, t1) ?? null,
        obs.facility,
        null, // 횡단보도 데이터 소스 없음 — 확인 불가(항상 생략)
      );
      const fixesInRow = recentFixesRef.current.filter(
        (f) => f.t_ms >= obs.start_ms && f.t_ms <= obs.end_ms,
      );
      const accInRow = fixesInRow.map((f) => f.accuracy_m).filter((a): a is number => a != null);
      const avgAccuracy = accInRow.length ? accInRow.reduce((s, a) => s + a, 0) / accInRow.length : null;
      const stepDelta = stepTrackerRef.current?.stepsBetween(obs.start_ms, obs.end_ms) ?? null;

      return {
        route_id:    obs.route_id,
        distance_m:  obs.distance_m,
        slope_mean:  obs.slope_mean,
        slope_max:   obs.slope_max,
        ascent_m:    obs.ascent_m,
        descent_m:   obs.descent_m,
        elapsed_ms:  obs.elapsed_ms,
        gps_sample_n: fixesInRow.length,
        step_delta:  stepDelta,
        stop_class:  rowAgg.stopClass,
        dwell_ms:    rowAgg.dwellMs,
        moving_ms:   rowAgg.movingMs,
        avg_gps_accuracy: avgAccuracy,
        device_model: deviceModelRef.current,
        near_crossing: rowAgg.nearCrossing,
        facility:    rowAgg.facility,
        valid:       rowAgg.valid,
        uncertain_reason: rowAgg.uncertainReason ?? null,
        slope_source: obs.slope_source,
      };
    },
    [],
  );

  /**
   * 개인화 계측 세션을 실제로 시작한다 — 동의(granted)한 경우에만 호출된다.
   * 세션 객체 + bin 트래커 생성 + 경로 형상 스냅샷(route_profile) 1회 적재.
   */
  const beginCollection = useCallback((initTime: number) => {
    if (collectSessionRef.current) return;              // 중복 방지
    collectSessionRef.current = new CollectSession(
      route?.params?.collectSessionId,
      route?.params?.collectSessionStartSeq,
    );
    // S1 — 걸음 수 구독도 같은 동의 시점에 시작. 실패해도(센서 없음/권한 거부)
    // 안내 흐름을 막지 않는다 — start()가 내부에서 삼킴.
    stepTrackerRef.current = new StepTracker();
    stepTrackerRef.current.start().then((ok) => {
      console.log(`[StepTracker] 시작 ${ok ? "성공" : "실패(null fallback)"}`);
    });
    // 세션이 안내 종료 시 null 로 비워진 뒤에도 구간평가(신호 D) POST 가 session_id 를
    // 실을 수 있도록 문자열만 따로 보존한다 (신호 A/B 와 조인용).
    collectSessionIdRef.current = collectSessionRef.current.sessionId;
    // sessions 행 생성은 여기서 직접, /navigation/start와 독립적으로 낸다 — 예전엔
    // /navigation/start 요청 본문의 session_id에만 기댔는데, 그 요청은 동의 모달
    // 응답을 기다리지 않고 즉시 나가서 "unknown 상태로 시작한 첫 걸음"은 여기서
    // beginCollection이 나중에(모달 응답 이후) 불려도 sessions 행이 영영 안
    // 생겼다(실측: uid 9명·route 102개 중 session 1건 — "드문 edge case"가 아니라
    // 사실상 모든 최초 세션의 기본 경로였음). sessions는 route_id를 안 가진 독립
    // 엔티티라 이 호출과 /navigation/start 중 뭐가 먼저 끝나든 상관없다 — 둘 다
    // submitSegment 시점(첫 unit을 실제로 지날 때)까지만 있으면 된다. 실패해도
    // 던지지 않는다 — gps-batch/submitSegment 쪽이 sessions 부재를 이미 조용히
    // no-op 처리하므로 이 호출 실패가 나머지 안내 흐름을 막을 이유는 없다.
    getAuthToken().then((token) => {
      if (!token) return;
      startCollectSession({
        sessionId:  collectSessionRef.current!.sessionId,
        walkerType,
        appVersion: APP_VERSION,
        schemaVer:  MEASUREMENT_SCHEMA_VERSION,
      }, token).catch(() => {});
    }).catch(() => {});
    gpsTraceBufferRef.current = new GpsTraceBuffer(
      collectSessionRef.current.sessionId,
      route?.params?.gpsTraceStartSeq,
    );
    distanceRowTrackerRef.current = new DistanceRowTracker(initTime);
    try {
      collectSessionRef.current.setRouteProfile({
        route_id: serverRouteIdRef.current,
        total_length_m: Number(routeData?.totalDistance) || undefined,
        segments: routeSegments.map((s: any) => ({
          slope: Number(s.slope ?? s.slope_pct ?? 0),
          length_m: Number(s.length ?? s.length_m ?? 5),
        })),
        coordinates: (coordinates ?? []).map((c: any) => [c.longitude, c.latitude]) as [number, number][],
      });
    } catch { /* 스냅샷 실패는 수집 자체를 막지 않는다 */ }
  }, [route?.params?.collectSessionId, routeSegments, routeData, coordinates, walkerType]);

  const visitedWaypointsRef = useRef<Set<number>>(new Set());

  // GPS 구독 ref — 안내 종료 시 즉시 해제
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

  // 대중교통 탑승 중 반복 하차 안내 인터벌 — 화면을 떠나거나(뒤로가기)
  // 다음 도보 구간을 시작하면 반드시 정리해야 한다.
  const alightReminderRef = useRef<ReturnType<typeof setInterval> | null>(null);
  function stopAlightReminder() {
    if (alightReminderRef.current) {
      clearInterval(alightReminderRef.current);
      alightReminderRef.current = null;
    }
  }

  // 도보1(승차 지점까지) 구간이 GPS로 실제 완료되는 순간 한 번만 다음
  // 구간으로 자동 전환하기 위한 가드 — "다음 도보 구간 시작" 확인 팝업을
  // 없애고 GPS 도착 감지로 대체했다(전체 여정이 이미 지도에 다 보이므로
  // 수동 확인이 불필요하다는 사용자 요청).
  const legTransitionedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let gpsWatchdog: ReturnType<typeof setTimeout> | null = null;

    async function startLocationWatch() {
      try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log("[GPS] 권한 상태:", status);
      if (status !== "granted") {
        if (mounted) setLocationError("위치 권한이 허용되지 않았습니다.");
        return;
      }

      // 권한은 있어도 기기 자체 위치 서비스가 꺼져 있으면 GPS 콜백이
      // 영영 안 온다 — 권한 체크만으론 못 잡는 케이스라 별도 확인.
      const providerStatus = await Location.getProviderStatusAsync();
      console.log("[GPS] 위치 서비스:", JSON.stringify(providerStatus));
      if (!providerStatus.locationServicesEnabled) {
        if (mounted) setLocationError("위치 서비스가 꺼져 있습니다.");
        Alert.alert(
          "위치 서비스 꺼짐",
          "설정에서 위치 서비스를 켜주세요.\n(갤럭시 기기: 설정 → 위치 → 사용 중 + 위치 서비스 → Google 위치 정확도 켜기)",
          [
            { text: "설정 열기", onPress: () => Linking.openSettings() },
            { text: "취소", style: "cancel" },
          ]
        );
        return;
      }
      if (providerStatus.gpsAvailable === false && providerStatus.networkAvailable === false) {
        if (mounted) setLocationError("GPS와 네트워크 위치를 모두 사용할 수 없습니다.");
        return;
      }

      // watchPositionAsync가 첫 콜백을 못 받고 계속 대기하는 경우(약한 신호,
      // 실내 등) 화면이 멈춘 것처럼 보이지 않도록 일정 시간 후 안내 문구를 띄운다.
      gpsWatchdog = setTimeout(() => {
        if (mounted) {
          setLocationError("위치를 찾는 데 시간이 걸리고 있습니다. 실외로 이동해보세요.");
        }
      }, 8000);

      const initTime = Date.now();
      segmentStartTimesRef.current = Array(routeSegments.length).fill(initTime);
      measuredMsRef.current        = Array(routeSegments.length).fill(null);
      currentSegIdxRef.current     = 0;
      // measurementUnits(30m+ 단위)도 대칭으로 초기화 — 채우지 않으면 첫 콜백에
      // unit이 닫힐 때 now - undefined = NaN 이 그대로 submitSegment로 나가
      // BE 400 → catch(()=>{})로 조용히 유실된다(인덱스는 이미 전진해 재시도도 없음).
      unitStartTimesRef.current = Array(measurementUnits.length).fill(initTime);
      currentUnitIdxRef.current = 0;
      unitGapPendingRef.current = false;
      segGapPendingRef.current  = false;

      // 이전 세션에서 전송 못 하고 큐에 남은 배치는 동의 여부와 무관하게 재시도한다
      // (그 배치들은 당시 동의 상태에서 쌓인 것).
      drainCollectQueue().catch(() => {});
      lastGpsPosRef.current   = null;
      lastGpsTimeRef.current  = 0;

      speak(
        `${to}까지 안내를 시작합니다. 총 거리 ${formatDistance(routeData?.totalDistance)}, ` +
        `예상 시간 ${formatTime(routeData?.totalDistance, walkerType, routeData?.estimatedTimeS ?? routeData?.routes?.[0]?.estimatedTimeS)}.`
      );

      // 개인화 계측은 명시적 동의가 있을 때만 시작한다 (이슈 #1). 측정 파이프라인
      // v2(sessions/navigation_measurements/gps_traces)도 동의 범위 **안**이다 —
      // CONSENT_BODY(collectConsent.ts)가 "구간별 경사도와 통과 시간·속도(GPS
      // 기반)"을 동의 항목으로 명시한다. 그래서 session_id는 consent가 확정된
      // 뒤(=collectSessionIdRef.current가 채워진 뒤)에만 /navigation/start에
      // 실어 보낸다 — route.params.collectSessionId를 동의와 무관하게 직접 쓰던
      // 이전 버전은 동의 없이도 서버에 session_id를 보내 sessions 행을 만들어
      // 버려 동의 문구와 어긋났다(session_id가 없으면 submitSegment도 이후
      // 아예 전송하지 않음 — 아래 GPS 콜백의 unit 루프 참고).
      //   granted  → beginCollection으로 세션 확정 후 이어서 /navigation/start
      //   unknown  → 도보 안내면 모달을 띄운다. 사용자 응답을 무한정 기다릴 수
      //              없으므로 이번 /navigation/start는 세션 없이 나간다 — 예전엔
      //              여기서 늦게 동의해도 이번 경로의 navigation_measurements가
      //              유실됐지만(sessions 행이 /navigation/start에만 의존),
      //              이제 beginCollection() 자체가 /collect/session/start로
      //              독립적으로 sessions 행을 만들어서(api/collect.ts) 모달에서
      //              뒤늦게 동의해도 그 순간부터 정상 수집된다 — 실측(uid 9명·
      //              route 102개 중 session 1건)으로 이 케이스가 edge case가
      //              아니라 사실상 기본 경로였음이 드러나 구조를 바꿨다.
      //   denied   → 세션 없이 진행(기존과 동일)
      getCollectConsent().then((consent) => {
        if (!mounted) return;
        // 디버그용, 검증 후 제거 예정 — beginCollection 게이트가 되는 consent 값
        // 확인 (9/17~ 왕복 세션 신호 A/B 0건 조사).
        console.warn(`[collect][DEBUG] getCollectConsent 반환값=${consent}`);
        if (consent === "granted") beginCollection(initTime);
        else if (consent === "unknown" && (mode ?? "walk") === "walk") setConsentPrompt(true);
      }).catch(() => {}).finally(() => {
        if (!mounted) return;
        // 서버 내비게이션 세션 시작 (best-effort)
        getAuthToken().then(async (token) => {
          if (!token) return;
          try {
            const sid = collectSessionIdRef.current ?? undefined;
            const { route_id } = await startNavigation(token, {
              from_name:      from,
              to_name:        to,
              mode:           mode ?? "walk",
              walker_type:    walkerType,
              total_segments: routeSegments.length,
              origin_lat:     originLat,
              origin_lon:     originLon,
              dest_lat:       destLat,
              dest_lon:       destLon,
              session_id:     sid,
              app_version:    sid ? APP_VERSION : undefined,
              schema_ver:     sid ? MEASUREMENT_SCHEMA_VERSION : undefined,
            });
            serverRouteIdRef.current = route_id;
          } catch (e) {
            console.log("[FE] 내비게이션 세션 시작 실패 (로컬만 유지):", e);
          }
        }).catch(() => {});
      });

      const last = await Location.getLastKnownPositionAsync({});
      if (last && mounted) {
        setCurrentLocation({ latitude: last.coords.latitude, longitude: last.coords.longitude });
      }

      console.log("[GPS] watchPosition 시작");
      // S0 보완 — handleGpsFix는 세 정확도 단계(startGpsWatch, 아래) 공통 콜백이라
      // const로 뽑아 재사용한다. 콜백 내부 로직 자체는 기존과 동일.
      const handleGpsFix = (loc: Location.LocationObject) => {
          if (!mounted) return;

          if (!firstFixReceivedRef.current) {
            firstFixReceivedRef.current = true;
            if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }
            const fixMs = Date.now() - watchStartTimeRef.current;
            console.log(`[GPS] 첫 픽스 수신 — stage=${gpsFixStageRef.current} ${fixMs}ms`);
            const sid = collectSessionIdRef.current;
            if (sid) {
              getAuthToken().then((token) => {
                if (!token) return;
                reportGpsFixStage({ sessionId: sid, stage: gpsFixStageRef.current, fixMs }, token).catch(() => {});
              }).catch(() => {});
            }
          }

          console.log("[GPS] 위치 수신:", loc.coords.latitude, loc.coords.longitude, "정확도:", loc.coords.accuracy);

          if (gpsWatchdog) { clearTimeout(gpsWatchdog); gpsWatchdog = null; }
          setLocationError((prev) => (prev.startsWith("위치를 찾는 데") ? "" : prev));

          setCurrentLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });

          const now = Date.now();

          // GPS 원본 궤적 로깅 — 정확도 필터(아래)보다 먼저 기록한다. 저정확도
          // 픽스도 accuracy_m과 함께 원본으로 남겨야, 필터 때문에 판정에서 빠진
          // 구간을 사후에 원본으로 들여다볼 수 있다. 판정 로직과 무관한 순수
          // push라 이 아래 어떤 흐름에도 영향을 주지 않는다.
          gpsTraceBufferRef.current?.push({
            t_ms:       now,
            lat:        loc.coords.latitude,
            lon:        loc.coords.longitude,
            accuracy_m: loc.coords.accuracy ?? null,
            speed_mps:  loc.coords.speed ?? null,
          });

          // S2 — stopClassifier용 최근 픽스 보관(별도 목적, 위 주석 참고).
          recentFixesRef.current.push({
            t_ms:       now,
            lat:        loc.coords.latitude,
            lon:        loc.coords.longitude,
            accuracy_m: loc.coords.accuracy ?? null,
            speed_mps:  loc.coords.speed ?? null,
          });
          const fixCutoff = now - RECENT_FIXES_KEEP_MS;
          while (recentFixesRef.current.length > 1 && recentFixesRef.current[1].t_ms < fixCutoff) {
            recentFixesRef.current.shift();
          }

          // S3 — gps_sample_n(콜백 횟수) 카운팅은 recentFixesRef 기반 집계로
          // 옮겨감(classifyElapsed 호출 시 자동으로 셈) — 별도 카운터 불필요.

          // 2026-09 1단계 완화(20m→30m) — 실기기 미검증, 다음 세션에서 실측 확인 필요.
          if (loc.coords.accuracy && loc.coords.accuracy > 30) return;

          // P0(elapsed_ms 보정) — 이번 콜백이 진행률을 얼마나 앞당기는지 보려면
          // update() 호출 전 시점의 값이 필요하다. lastGpsTimeRef는 신호 B 블록
          // (아래)에서야 now로 갱신되므로 여기선 아직 "직전 콜백" 시각 그대로다.
          const prevProgressMForCrossing = routeProgressTracker.maxProgressM();
          const prevGpsTimeForCrossing   = lastGpsTimeRef.current;

          // 2026-09 2단계 — 이 픽스를 경로 진행률 트래커에도 반영(위 useMemo 주석
          // 참고). 아래 두 while 루프의 "반경 밖이어도 경로상 이미 지나쳤으면
          // 통과 인정" 판정이 이 값을 쓴다.
          routeProgressTracker.update({
            latitude:  loc.coords.latitude,
            longitude: loc.coords.longitude,
          });

          gpsCallbackCountRef.current += 1;
          if (gpsCallbackCountRef.current === 2 && currentSegIdxRef.current === 0) {
            segmentStartTimesRef.current[0] = now;
            // 첫 bin 의 elapsed 도 "실제 이동 시작"에 맞춘다 — GPS 락 대기 시간이
            // 첫 bin 속도에 섞여 들어가지 않도록(§3.2 신호 A는 distance/elapsed 기반).
            distanceRowTrackerRef.current?.anchorStart(now);
          }
          // measurementUnits 트래킹도 같은 "실제 이동 시작" 시각으로 앵커한다 —
          // routeSegments와 별개 배열이라 인덱스는 독립이지만, 기준 시각은 같아야
          // GPS 락 대기 시간이 unit 0 소요시간에 섞이지 않는다.
          if (gpsCallbackCountRef.current === 2 && currentUnitIdxRef.current === 0) {
            unitStartTimesRef.current[0] = now;
          }

          // 신호 B — 순간속도 원본 저장 (판정 없음, §3.2 / §3.8).
          // 직전 픽스와의 거리/시간으로 순간속도를 구해 현재 구간 경사 bin에 귀속시킨다.
          {
            const curPos = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
            const prevPos = lastGpsPosRef.current;
            const prevT   = lastGpsTimeRef.current;
            if (prevPos && prevT) {
              const d  = haversineDistance(prevPos, curPos);
              const dt = (now - prevT) / 1000;
              // S3 — GPS 점프 판정을 고정거리(100m)에서 암묵속도/정확도 기준으로
              // 교체(config.ts 주석 참고). d/dt(암묵속도)가 도보로 낼 수 없는
              // 속도이거나, 정확도 자체가 나쁘면 이 픽스가 만든 이동은 못 믿는다.
              const impliedSpeed = dt > 0 ? d / dt : Infinity;
              const accuracyM = loc.coords.accuracy ?? null;
              const isJump = impliedSpeed > IMPLIED_SPEED_JUMP_MPS ||
                (accuracyM != null && accuracyM > JUMP_ACCURACY_MAX_M);
              if (dt > 0 && dt < SPEED_SAMPLE_MAX_GAP_S && !isJump) {
                const v = impliedSpeed;
                collectSessionRef.current?.addSpeedSample({
                  route_id:       serverRouteIdRef.current ?? undefined,
                  slope_bin:      binCenter(routeSegments[currentSegIdxRef.current]?.slope ?? 0),
                  sub_distance_m: d,
                  speed_ms:       v,
                });
                // 정상 판정이 한 번이라도 성공하면 오염 플래그를 바로 내린다 — 원래는
                // 이 unit이 닫힐 때(아래 gapConsumed)까지 기다렸는데, 실기기 콜백 간격이
                // SPEED_SAMPLE_MAX_GAP_S 근처/이상으로 흔해서(sess-1789364304261-iy39nwa8
                // 42%) 다음 unit이 닫히기 전에 또 다른 콜백이 새로 공백 판정을 일으켜
                // 플래그가 사실상 계속 true로 남는 문제가 있었다(모든 unit이 skipped).
                // 트레이드오프: 공백 발생 직후 곧바로 복구되면(다음 콜백이 정상) 그
                // 사이 열려 있던 unit의 elapsed_ms 에는 여전히 공백 시간이 섞여 있는데도
                // 이 unit이 나중에 닫힐 때 skipped로 안 잡힐 수 있다 — 단, 그 경우
                // 공백 길이 자체가 SPEED_SAMPLE_MAX_GAP_S(20s) 미만이라 애초에 이 분기가
                // 아니라 위 분기(정상)로 처리됐을 가능성이 높다. 20s 이상 실제 GPS
                // 유실(터널 등) 후 바로 다음 콜백이 정상 복귀하는 드문 경우만 이 완화의
                // 영향을 받는다 — 현재 100% skip으로 데이터가 전혀 안 쌓이는 것보다
                // 낫다고 판단.
                unitGapPendingRef.current = false;
                segGapPendingRef.current  = false;
              } else if (dt >= SPEED_SAMPLE_MAX_GAP_S || isJump) {
                // GPS 점프/장시간 공백 — 이 표본만이 아니라 진행 중이던 행 관측
                // 전체를 버린다 (점프 앞뒤로 거리·시간 오염, Q&A #5).
                distanceRowTrackerRef.current?.invalidateCurrent(now);
                // measurementUnits 쪽도 같은 이유로 오염 — 지금 진행 중이던 unit이
                // 다음에 닫힐 때 elapsed에 이 공백/점프 구간 전체가 섞여 들어간다
                // (DB 분석에서 찾은 "9.9m 구간에 27700ms" 패턴). 그 unit이 닫히는
                // 시점에 status='skipped'로 보내도록 표시만 해 둔다. routeSegments
                // 루프(로컬 SegmentTime)도 같은 공백을 겪으므로 별도 플래그로 동일 표시.
                unitGapPendingRef.current = true;
                segGapPendingRef.current  = true;
                if (__DEV__) console.warn(`[collect] GPS 점프/공백으로 행 무효화 (dt=${dt.toFixed(1)}s d=${d.toFixed(0)}m impliedV=${impliedSpeed.toFixed(1)}m/s)`);
              }
            }
            lastGpsPosRef.current  = curPos;
            lastGpsTimeRef.current = now;
          }

          // 이 콜백 진입 시점의 오염 여부를 고정(unit 루프와 동일 패턴, 아래
          // measurementUnits 루프의 gapPendingAtStart 참고) —
          // 신호 B/AppState 핸들러가 이 루프보다 먼저 돈다. 이 시점 값은 이미 이번
          // tick의 신호 B 블록을 거친 뒤라, 정상 판정이 성공했으면 위에서 이미
          // false로 내려가 있을 수 있다.
          const segGapPendingAtStart = segGapPendingRef.current;
          let segGapConsumed = false;
          let segsThisTick = 0; // 이 콜백 안에서 이미 몇 개의 세그먼트를 지났는지

          let curIdx = currentSegIdxRef.current;
          while (curIdx < routeSegments.length) {
            const seg = routeSegments[curIdx];
            const dist = haversineDistance(
              { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
              seg.end
            );
            // 2026-09 2단계 — 반경 밖이어도 경로 진행률이 이 구간 끝점을 이미
            // 지났으면(폴리라인 투영 기준) 통과로 인정한다. GPS가 흔들리거나
            // 끝점을 살짝 비껴 찍어도, 실제로 경로를 따라 지나왔다면 놓치지 않는다.
            const passedByProgress = routeProgressTracker.maxProgressM() >= segEndArcLength[curIdx];
            if (dist >= PROXIMITY_THRESHOLD && !passedByProgress) {
              // curIdx의 끝점 25m 반경에 못 들었다 — 콜백 공백/점프로 이 세그먼트를
              // 그냥 지나쳤을 수 있다(실기기 dt 최대 27.7s 관측, 신호 B 조사).
              // 예전엔 여기서 바로 break해 다음 콜백을 기다렸는데, 그 다음 콜백도
              // curIdx 끝점만 보므로 이미 지나친 지점엔 영원히 다시 가까워지지
              // 않아 이후 세그먼트 전체(및 routeSegments 소진에 의존하는 대중교통
              // leg 자동전환)가 그대로 멈춰 섰다. measurementUnits 루프(아래)의
              // catch-up과 같은 방식으로, 앞쪽 몇 개를 미리 훑어 지금 위치와
              // 실제로 가까운 세그먼트가 있으면 그 지점까지 건너뛴다.
              let caughtUpIdx = -1;
              const lookaheadEnd = Math.min(routeSegments.length, curIdx + 1 + SEGMENT_CATCHUP_LOOKAHEAD);
              for (let j = curIdx + 1; j < lookaheadEnd; j++) {
                const d2 = haversineDistance(
                  { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
                  routeSegments[j].end
                );
                if (d2 < PROXIMITY_THRESHOLD) { caughtUpIdx = j; break; }
              }
              if (caughtUpIdx === -1) break; // 아직 어디에도 안 가까움 — 다음 콜백 대기

              // curIdx..caughtUpIdx는 통째로 건너뛴 세그먼트다 — caughtUpIdx 자체도
              // "언제 시작했는지" 모르는 채로 끝점만 확인된 것이라, elapsed를 만들면
              // (now - 옛 시작시각) 그대로 공백 시간이 섞여 들어간다(unit 쪽에서 잡던
              // "9.9m에 27700ms" 오염과 동일 패턴). 그래서 caughtUpIdx까지 전부 미측정
              // 처리하고, 다음(caughtUpIdx+1)부터 "지금 막 도착한 지점"을 새 시작점으로
              // 깨끗하게 다시 잰다. measuredMsRef는 이미 null로 채워져 있어(§1441
              // "미통과·부분통과 → 저장 안 함") 따로 표시할 것도 없다 — signal A(bin)
              // 쪽만 outsideSeoul과 동일하게 무효화해 거리·시간이 다음 bin에 안 섞이게 한다.
              for (let k = curIdx; k <= caughtUpIdx; k++) {
                distanceRowTrackerRef.current?.invalidateCurrent(now);
              }
              curIdx = caughtUpIdx + 1;
              currentSegIdxRef.current = curIdx;
              if (curIdx < routeSegments.length) {
                segmentStartTimesRef.current[curIdx] = now;
              }
              continue; // 새 curIdx를 다음 while 반복에서 정상 경로로 재평가
            }

            // P0-1과 동일한 경계 보간(S3 요구) — "콜백 수신 시각"이 아니라 이
            // 구간 끝점을 실제로 지난 시각을 추정해 쓴다.
            const segCrossTime = interpolateCrossingTime(
              prevProgressMForCrossing, prevGpsTimeForCrossing,
              routeProgressTracker.maxProgressM(), now,
              segEndArcLength[curIdx],
            );
            const elapsed = segCrossTime - segmentStartTimesRef.current[curIdx];
            const nextSeg = curIdx + 1 < routeSegments.length ? routeSegments[curIdx + 1] : null;

            // 오염 사유 둘 — 아래 measurementUnits 루프("skip 사유 둘")와 동일한 논리:
            //  1) 이 콜백 한 번에 세그먼트를 2개 이상 지났다(segsThisTick>0) — 두
            //     번째부터는 시작시각이 방금 같은 tick에 세팅돼 elapsed가 사실상 0.
            //     실기기 콜백 지연(dt 최대 27.7s)으로 짧은 세그먼트 여러 개가 한
            //     tick에 몰리면 흔히 나온다("첫 구간 과다측정 + 다음 2~3구간 0초"
            //     증상 원인).
            //  2) 이 세그먼트가 열려 있던 동안 GPS 공백/점프가 있었다
            //     (segGapPendingAtStart) — 1개만 닫혀도 elapsed에 공백이 섞여있다.
            const isCatchUpSeg = segsThisTick > 0 || segGapPendingAtStart;
            if (segGapPendingAtStart && segsThisTick === 0) segGapConsumed = true;

            if (seg.outsideSeoul) {
              // 서울 밖(경사 데이터 없는 직선) 구간 — 측정·제출·신호 A/D 판단에서 제외.
              // GPS 공백/중도 종료 구간과 동일하게 현재 bin 을 무효화하고 그냥 지나간다.
              distanceRowTrackerRef.current?.invalidateCurrent(now);
            } else {
              // 오염된 세그먼트는 measuredMsRef에 아예 안 남긴다(null 유지) — 종료
              // 시 "미통과·부분통과 → 저장 안 함"(§1441)과 같은 경로로 자연스럽게
              // 빠져서, RouteDetailScreen/MyPageScreen 양쪽 다 0초로 새지 않고
              // 그 구간이 통째로 안 보이게 된다(가짜 값보다 낫다는 이 파이프라인
              // 전체 원칙과 동일, unit 쪽 status='skipped'와 대응).
              if (!isCatchUpSeg) {
                measuredMsRef.current[curIdx] = elapsed;
              }

              // BE 제출(submitSegment)은 더 이상 여기서 하지 않는다 — measurement_units
              // 기준(아래 별도 while 루프)으로만 나간다. measuredMsRef는 로컬 기록
              // (SegmentTime, 마이페이지 표시용)에만 계속 쓰인다.

              // 신호 A(S3) — 이 구간을 현재 행(고정 25m)에 누적하고, ROW_LEN_M을
              // 넘기면 "직전에 완성된 행"(1행 지연 스트리밍, distanceRowTracker.ts
              // 참고)을 돌려받는다.
              const obs = distanceRowTrackerRef.current?.completeSegment(
                seg.length ?? 5,
                seg.slope ?? 0,
                segCrossTime,
                serverRouteIdRef.current,
                seg.is_stairs ?? false,
                seg.slope_source ?? "missing",
              );
              if (obs) {
                collectSessionRef.current?.addSlopeObservation(buildSlopeObservationPayload(obs));
                // 안전 음성 안내는 zone 기준 유지 (self-dedupe)
                announceZoneEntry(nextSeg ? getZoneKey(nextSeg.zone, nextSeg.direction) : null);
              }
            }

            segsThisTick += 1;
            curIdx += 1;
            currentSegIdxRef.current = curIdx;
            if (curIdx < routeSegments.length) {
              segmentStartTimesRef.current[curIdx] = now;
            }
          }
          // 보조 리셋 경로 — 주 리셋은 신호 B 블록(정상 판정 성공 시 즉시, §1136)에서
          // 일어난다. 여기 남겨두는 이유: 신호 B가 공백을 세팅한 바로 그 tick에
          // 마침 세그먼트 경계도 함께 지나는 경우, 다음 tick의 신호 B를 기다릴
          // 것 없이 이 tick에서 바로 소비·리셋해 다음 세그먼트부터는 정상 처리되게 한다.
          if (segGapConsumed) segGapPendingRef.current = false;

          // 측정 파이프라인 v2 — measurement_units(≥30m) 기준 GPS 도착판정. 위
          // routeSegments 루프(신호 A/안내용)와 완전히 독립적으로 돈다 — 인덱스
          // 체계도, 종료 좌표(end_coords)도 서로 다른 분할이라 하나의 루프로
          // 합칠 수 없다(measurement_units.py 설계 메모 참고).
          {
            // session_id는 개인화 계측 동의가 확정된 뒤에만 채워지는
            // collectSessionIdRef를 쓴다(동의 게이트 — 위 startLocationWatch의
            // /navigation/start 결정과 동일 근거: CONSENT_BODY가 "구간별 경사도와
            // 통과 시간·속도"를 명시적 동의 항목으로 적어뒀다). 세션이 없으면(동의
            // 안 함/아직 모달 응답 전) submitSegment 자체를 호출하지 않는다.
            const sid = collectSessionIdRef.current ?? undefined;
            // 이 콜백 진입 시점의 오염 여부를 고정해 둔다 — 루프 도중 새로
            // 세팅될 일은 없지만(신호 B/AppState 핸들러는 이 루프보다 먼저 돈다),
            // 소비 후 리셋 타이밍을 이 tick 하나로 명확히 하기 위함. 이 시점의 값은
            // 이미 이번 tick의 신호 B 블록을 거친 뒤다 — 이번 tick에서 정상 판정이
            // 성공했으면 위에서 이미 false로 내려가 있을 수 있다(그 경우 이 unit은
            // catch-up 사유로만 skip 여부가 갈린다).
            const gapPendingAtStart = unitGapPendingRef.current;
            let gapConsumed = false;
            let curUnitIdx = currentUnitIdxRef.current;
            let unitsThisTick = 0; // 이 콜백 안에서 이미 몇 개의 unit을 지났는지

            while (curUnitIdx < measurementUnits.length) {
              const unit = measurementUnits[curUnitIdx];
              const [endLng, endLat] = unit.end_coords;
              const distToUnitEnd = haversineDistance(
                { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
                { latitude: endLat, longitude: endLng }
              );
              // 2026-09 2단계 — routeSegments 루프와 동일한 보완: 반경 밖이어도
              // 경로 진행률이 이 unit 끝점을 이미 지났으면 통과로 인정한다.
              const passedByProgress =
                routeProgressTracker.maxProgressM() >= unitEndArcLength[curUnitIdx];
              if (distToUnitEnd >= PROXIMITY_THRESHOLD && !passedByProgress) {
                // routeSegments 루프와 동일한 문제 — curUnitIdx 끝점 25m을 콜백
                // 공백/점프로 그냥 지나쳤으면 여기서 break만 해선 이 unit도,
                // 이후 모든 unit도 영원히 안 닫힌다. 뒤쪽을 미리 훑어 지금
                // 위치와 실제로 가까운 unit이 있으면 그 지점까지 건너뛴다.
                let caughtUpIdx = -1;
                const lookaheadEnd = Math.min(measurementUnits.length, curUnitIdx + 1 + SEGMENT_CATCHUP_LOOKAHEAD);
                for (let j = curUnitIdx + 1; j < lookaheadEnd; j++) {
                  const [jLng, jLat] = measurementUnits[j].end_coords;
                  const dj = haversineDistance(
                    { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
                    { latitude: jLat, longitude: jLng }
                  );
                  if (dj < PROXIMITY_THRESHOLD) { caughtUpIdx = j; break; }
                }
                if (caughtUpIdx === -1) break; // 아직 어디에도 안 가까움 — 다음 콜백 대기

                // curUnitIdx..caughtUpIdx 전부 skip 처리한다 — caughtUpIdx도 포함해야
                // 한다: unitStartTimesRef[caughtUpIdx]는 애초에 curUnitIdx가 열릴 때
                // 세팅된(혹은 마운트 시 initTime으로 채워진) 값이라, 이 unit을 "정상
                // 측정"으로 처리하면 elapsedMs에 건너뛴 구간 전체(길게는 세션 시작
                // 이후 전체 경과)가 섞여 들어간다. caughtUpIdx+1부터 "지금 막 도착한
                // 지점"을 새 시작점으로 깨끗하게 다시 잰다.
                for (let k = curUnitIdx; k <= caughtUpIdx; k++) {
                  const su = measurementUnits[k];
                  const rid2 = serverRouteIdRef.current;
                  if (rid2 !== null && sid) {
                    const payload: MeasurementSegmentPayload = {
                      sessionId: sid ?? "", unitIndex: k,
                      distanceM: su.distance_m, slopePercent: su.slope_pct,
                      status: "skipped",
                      coordStartIdx: su.coord_start_idx, coordEndIdx: su.coord_end_idx,
                      startCoords: su.start_coords, endCoords: su.end_coords,
                    };
                    getAuthToken().then((token) => {
                      if (!token) return;
                      submitSegment(rid2, payload, token).catch(() => {});
                    }).catch(() => {});
                  }
                }
                // 건너뛴 마지막 경계(caughtUpIdx)를 지난 시점을 보간해, 다음
                // unit의 시작 앵커가 "이번 콜백 수신 시각"이 아니라 "실제로 그
                // 지점을 지났을 시각"이 되게 한다(P0: elapsed_ms 진입/이탈 시각화).
                const caughtUpCrossTime = interpolateCrossingTime(
                  prevProgressMForCrossing, prevGpsTimeForCrossing,
                  routeProgressTracker.maxProgressM(), now,
                  unitEndArcLength[caughtUpIdx],
                );
                curUnitIdx = caughtUpIdx + 1;
                currentUnitIdxRef.current = curUnitIdx;
                if (curUnitIdx < measurementUnits.length) {
                  unitStartTimesRef.current[curUnitIdx] = caughtUpCrossTime;
                }
                continue; // 새 curUnitIdx를 다음 while 반복에서 정상 경로로 재평가
              }

              // skip 사유 둘:
              //  1) 이 콜백 한 번에 unit을 2개 이상 지났다(catch-up) — 두 번째
              //     unit부터 elapsed가 사실상 0이라 실측이 아니다. BE는 갭을
              //     추론하지 않으므로 이 판단은 FE 책임이다(app.py 참고).
              //  2) 이 unit이 열려 있던 동안 GPS 공백/점프가 있었다(gapPendingAtStart)
              //     — catch-up이 아니어도(1개만 닫혀도) elapsed에 그 공백 전체가
              //     섞여 있다("9.9m 구간에 27700ms" 패턴). 이 콜백에서 처음 닫히는
              //     unit 하나에만 적용하고 이후(같은 tick 안의 진짜 catch-up)는
              //     이유 1로 이미 skip 처리된다.
              const isCatchUp = unitsThisTick > 0 || gapPendingAtStart;
              if (gapPendingAtStart && unitsThisTick === 0) gapConsumed = true;
              const unitIdx = curUnitIdx;
              const rid = serverRouteIdRef.current;

              // P0(elapsed_ms 진입/이탈 시각화) — "콜백을 받은 시각(now)"이 아니라
              // 직전 콜백~이번 콜백 사이를 등속 가정해 이 unit 끝점을 실제로 지난
              // 시각을 추정한다. isCatchUp이어도 다음 unit의 시작 앵커로 재사용되므로
              // 항상 계산한다.
              const crossTime = interpolateCrossingTime(
                prevProgressMForCrossing, prevGpsTimeForCrossing,
                routeProgressTracker.maxProgressM(), now,
                unitEndArcLength[unitIdx],
              );

              // S2 — stopClassifier로 이 unit의 valid/dwell/moving/facility 집계.
              // catch-up(unit을 건너뜀)이면 계산할 근거(온전한 창)가 없어 생략 —
              // 어차피 status='skipped'라 BE가 이 필드들을 안 받는다.
              const unitAgg = isCatchUp ? null : classifyElapsed(
                recentFixesRef.current,
                unitStartTimesRef.current[unitIdx],
                crossTime,
                computeVStop(null), // 개인 평지속도 미연동 — 기본값(S8/S10에서 재검토)
                (t0, t1) => stepTrackerRef.current?.stepsBetween(t0, t1) ?? null,
                unit.is_stairs,
                null, // 횡단보도 노드 거리 데이터 소스 없음 — 확인 불가(항상 생략)
              );

              const payload: MeasurementSegmentPayload = isCatchUp
                ? {
                    sessionId: sid ?? "", unitIndex: unitIdx,
                    distanceM: unit.distance_m, slopePercent: unit.slope_pct,
                    status: "skipped",
                    coordStartIdx: unit.coord_start_idx, coordEndIdx: unit.coord_end_idx,
                    startCoords: unit.start_coords, endCoords: unit.end_coords,
                  }
                : {
                    sessionId: sid ?? "", unitIndex: unitIdx,
                    distanceM: unit.distance_m, slopePercent: unit.slope_pct,
                    status: "measured", elapsedMs: crossTime - unitStartTimesRef.current[unitIdx],
                    valid: unitAgg!.valid, dwellMs: unitAgg!.dwellMs, movingMs: unitAgg!.movingMs,
                    facility: unitAgg!.facility, stopClass: unitAgg!.stopClass, nearCrossing: unitAgg!.nearCrossing,
                    coordStartIdx: unit.coord_start_idx, coordEndIdx: unit.coord_end_idx,
                    startCoords: unit.start_coords, endCoords: unit.end_coords,
                  };

              // sid가 없으면(동의 없음/모달 응답 전) BE가 session_id를 필수로
              // 요구하므로 애초에 보내지 않는다.
              if (rid !== null && sid) {
                getAuthToken().then((token) => {
                  if (!token) return;
                  submitSegment(rid, payload, token).catch(() => {});
                }).catch(() => {});
              }

              unitsThisTick += 1;
              curUnitIdx += 1;
              currentUnitIdxRef.current = curUnitIdx;
              if (curUnitIdx < measurementUnits.length) {
                unitStartTimesRef.current[curUnitIdx] = crossTime;
              }
            }

            // 이 리셋은 이제 보조 경로다 — 주 리셋은 위 신호 B 블록(정상 판정
            // 성공 시 즉시)에서 일어난다. 여기 남겨두는 이유: 신호 B가 공백을
            // 세팅한 바로 그 tick에 마침 unit 경계도 함께 지나는 경우, 그 unit은
            // (gapPendingAtStart=true라) 여전히 skip 처리해야 하지만 다음 tick의
            // 신호 B를 기다릴 것 없이 이 tick에서 바로 소비·리셋해 다음 unit부터는
            // 정상 처리되게 한다.
            if (gapConsumed) unitGapPendingRef.current = false;
          }

          // 도보1(승차 지점까지) 구간의 모든 세그먼트를 GPS로 실제 통과했으면
          // 확인 팝업 없이 바로 탑승 안내를 읽어주고 다음 구간(하차 후 도보)
          // 화면으로 넘어간다. transitNextLeg가 있는 leg(=도보1)에서만 동작.
          if (
            mode === "transit" &&
            transitNextLeg?.nextLegParams &&
            !legTransitionedRef.current &&
            routeSegments.length > 0 &&
            currentSegIdxRef.current >= routeSegments.length
          ) {
            legTransitionedRef.current = true;

            const guidanceText =
              (transitNextLeg.ridingGuidance ?? []).join("\n") ||
              "대중교통을 이용해 다음 구간으로 이동하세요.";
            const alightText = transitNextLeg.alightStationName
              ? `${transitNextLeg.alightStationName}에서 내리세요.`
              : guidanceText.replace(/\n/g, ". ");

            speak(alightText);
            stopAlightReminder();
            alightReminderRef.current = setInterval(() => speak(alightText), 40_000);
            // 알려진 이슈(별도 트래킹, 지금 안 고침): 여기서 새 NavigationScreen을
            // 마운트하는 것 = 이전 leg는 completeNavigation을 절대 호출받지 못하고
            // routes.status='in_progress'로 영구히 남는다(postWalkParams에
            // serverRouteId 이어받는 값이 없어 이전 leg를 닫을 방법 자체가 없음).
            // 파일럿 전 DB에서 발견한 in_progress 방치 63건 중 일부는 "앱 종료/
            // 네트워크 유실"이 아니라 대중교통 정상 동작 중에도 구조적으로 이렇게
            // 생겼을 가능성이 있음. 멀티레그 "완료"를 leg 단위로 볼지 여정 전체로
            // 볼지 결정 필요 — 이번 측정 파이프라인 v2 작업 범위 밖(routes.status만
            // 남는 문제, CollectSession 쪽은 아래에서 별도로 잇는다).
            //
            // collectSessionId는 여기서 잇는다 — 예전엔 postWalkParams에 아예 안
            // 실려가서 leg마다 완전히 새 session_id가 발급됐다(신호 A/B/D가 leg
            // 경계에서 끊김). 그냥 sessionId만 이어주면 또 다른 문제가 생긴다 —
            // CollectSession 생성자가 seq를 항상 0부터 시작해서, 재사용된
            // session_id에 이전 leg가 이미 쓴 (uid,session_id,seq=0,1,2...)와
            // 겹쳐 백엔드 ON CONFLICT DO NOTHING(database.py save_collect_batch)에
            // 조용히 씹힌다. 그래서 이전 leg를 final flush로 완전히 닫고(seq 확정)
            // 그 다음 seq를 collectSessionStartSeq로 같이 넘긴다.
            {
              const cs = collectSessionRef.current;
              const finalObs = distanceRowTrackerRef.current?.finalize(now, serverRouteIdRef.current) ?? [];
              if (cs) { for (const obs of finalObs) cs.addSlopeObservation(buildSlopeObservationPayload(obs)); }
              collectSessionRef.current = null;
              distanceRowTrackerRef.current = null;

              // gps_traces(측정 파이프라인 v2 원본 궤적)도 같은 이유로 이어줘야
              // 한다 — nextSeq는 push()에서만 증가하므로(flush는 안 건드림) 지금
              // 값을 그대로 읽으면 되고, CollectSession처럼 flush 완료를 기다릴
              // 필요는 없다.
              const gtb = gpsTraceBufferRef.current;
              const gpsTraceStartSeq = gtb?.getNextSeqForHandoff();
              if (gtb) { void gtb.flush({ final: true }); }
              gpsTraceBufferRef.current = null;

              const goNextLeg = () => {
                navigation?.navigate("Navigation", {
                  ...transitNextLeg.nextLegParams,
                  collectSessionId: cs?.sessionId,
                  collectSessionStartSeq: cs?.getSeqForHandoff(),
                  gpsTraceStartSeq,
                });
              };
              if (cs) cs.flush({ final: true }).catch(() => {}).finally(goNextLeg);
              else goNextLeg();
            }
          }

          waypoints.forEach((wp, idx) => {
            if (visitedWaypointsRef.current.has(idx)) return;
            const dist = haversineDistance(
              { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
              { latitude: wp.lat, longitude: wp.lon }
            );
            if (dist <= PROXIMITY_THRESHOLD) {
              visitedWaypointsRef.current.add(idx);
              setGuidance({ turn: wp.turn_direction, text: wp.guidance_text });
              // speak() 래퍼를 거쳐야 음성안내 OFF(voiceEnabledRef)가 적용된다.
              // 예전엔 Speech.speak 를 직접 불러서, 껐다가도 다음 교차로에서
              // 다시 나오기 시작했다.
              speak(wp.guidance_text);
            }
          });
        };

      // S0 보완 — BestForNavigation이 실내·건물 인근에서 첫 픽스를 못 잡고
      // 무한 대기할 수 있어(옛 Accuracy.High 회피 사유와 동일 문제, 더 심할 수
      // 있음), FIRST_FIX_TIMEOUT_S 안에 첫 콜백이 없으면 정확도를 낮춰 재시도한다.
      // 에뮬레이터(geo fix)는 즉시 반영이라 이 타임아웃 경로 자체를 재현할 수
      // 없다 — docs/device_verification_pending.md.
      async function startGpsWatch(stageIndex: number): Promise<void> {
        const stages: { accuracy: Location.Accuracy; label: string }[] = [
          { accuracy: GPS_ACCURACY,            label: "best_nav" },
          { accuracy: GPS_ACCURACY_FALLBACK_1, label: "high" },
          { accuracy: GPS_ACCURACY_FALLBACK_2, label: "balanced" },
        ];
        const stage = stages[stageIndex];
        if (!stage) {
          // 세 단계 모두 첫 픽스 실패 — 마지막(balanced) 구독은 계속 살아있으니
          // 나중에 픽스가 오면 handleGpsFix가 정상 처리한다. 기록만 'none'으로.
          gpsFixStageRef.current = "none";
          return;
        }
        gpsFixStageRef.current = stage.label;
        watchStartTimeRef.current = Date.now();
        subscriptionRef.current = await Location.watchPositionAsync(
          { ...GPS_WATCH_OPTIONS, accuracy: stage.accuracy },
          handleGpsFix,
        );
        fallbackTimerRef.current = setTimeout(() => {
          if (!mounted || firstFixReceivedRef.current) return;
          console.log(`[GPS] stage=${stage.label} ${FIRST_FIX_TIMEOUT_S}s 내 첫 픽스 없음 — 다음 단계로 전환`);
          subscriptionRef.current?.remove();
          startGpsWatch(stageIndex + 1).catch(() => {});
        }, FIRST_FIX_TIMEOUT_S * 1000);
      }

      await startGpsWatch(0);
      console.log("[GPS] watchPosition 구독 성공");
      } catch (err: any) {
        console.log("[GPS] 에러:", err?.message ?? err);
        if (mounted) setLocationError("위치 정보를 가져오는 중 오류가 발생했습니다.");
      }
    }

    startLocationWatch();

    // 앱이 백그라운드로 나갔다 돌아오면, 그동안 GPS 픽스가 없어 진행 중이던 bin 의
    // elapsed_ms 에 "화면 꺼둔 시간"이 통째로 섞인다. 공백이 SPEED_SAMPLE_MAX_GAP_S
    // 를 넘으면 그 bin 을 버리고(다음 경계부터 다시), 직전 픽스도 리셋한다 (이슈 S3).
    const appStateSub = AppState.addEventListener("change", (state) => {
      // 디버그용, 검증 후 제거 예정 — 2분 타이머 미동작이 백그라운드 스로틀
      // 때문인지 확인 (9/17~ 왕복 세션 신호 A/B 0건 조사).
      console.warn(`[collect][DEBUG] AppState change → ${state}`);
      if (state === "background" || state === "inactive") {
        bgAtRef.current = Date.now();
      } else if (state === "active" && bgAtRef.current > 0) {
        const gapS = (Date.now() - bgAtRef.current) / 1000;
        bgAtRef.current = 0;
        if (gapS >= SPEED_SAMPLE_MAX_GAP_S) {
          distanceRowTrackerRef.current?.invalidateCurrent(Date.now());
          lastGpsPosRef.current = null;
          lastGpsTimeRef.current = 0;
          // 진행 중이던 measurementUnit/routeSegment 둘 다 같은 공백을 그대로
          // 삼킨다 — 다음에 닫힐 때 각자 오염 처리되도록 표시(위 신호 B 블록과 동일 플래그).
          unitGapPendingRef.current = true;
          segGapPendingRef.current  = true;
          if (__DEV__) console.warn(`[collect] 백그라운드 복귀 공백 ${gapS.toFixed(0)}s — 진행 중 bin/unit/segment 무효화`);
        }
      }
    });

    return () => {
      mounted = false;
      if (gpsWatchdog) clearTimeout(gpsWatchdog);
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      stepTrackerRef.current?.stop();
      stepTrackerRef.current = null;
      appStateSub.remove();
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      Speech.stop();
      stopAlightReminder();
      // 종료 버튼을 거치지 않고 화면이 사라지는 경우(대중교통 다음 leg로 자동 전환 등)에도
      // 진행 중이던 bin + 버퍼를 마지막으로 확정해 배치로 내보낸다.
      const cs = collectSessionRef.current;
      if (cs) {
        const finalObs = distanceRowTrackerRef.current?.finalize(Date.now(), serverRouteIdRef.current) ?? [];
        for (const obs of finalObs) cs.addSlopeObservation(buildSlopeObservationPayload(obs));
        void cs.flush({ final: true });
        collectSessionRef.current = null;
        distanceRowTrackerRef.current = null;
      }
      if (gpsTraceBufferRef.current) {
        void gpsTraceBufferRef.current.flush({ final: true });
        gpsTraceBufferRef.current = null;
      }
    };
  }, []);

  const currentLocationForMap = useMemo(() => {
    if (isLocationNearRoute(currentLocation, coordinates)) return currentLocation;
    return null;
  }, [currentLocation, coordinates]);

  // currentLocationForMap을 의도적으로 deps에서 뺐다 — 포함시키면 GPS가 움직일
  // 때마다(수 초 간격) 지도 HTML 전체가 재생성되어 WebView가 통째로 리로드되고,
  // 그 결과 지도가 매번 경로 bounds로 재축소된다("즉각 반영 안 됨" + "축소되며
  // 나타남" 원인). 최초 진입 시점의 위치만 initial overlay로 굽고, 그 다음부턴
  // 아래 useEffect가 bridge(window.updateCurrentLocation)로 마커만 옮긴다.
  const mapHtml = useMemo(
    () =>
      makeKakaoMapHtml({
        coordinates,
        navSegData,
        routeSegments,
        currentLocation: currentLocationForMap,
        from,
        to,
        showSlopeMarkers,
        journeyMapPath,
        journeyMapSegments,
        finalDestinationName,
        finalOriginName,
        walkerType,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coordinates, navSegData, routeSegments, from, to, showSlopeMarkers, journeyMapPath, journeyMapSegments, finalDestinationName, finalOriginName, walkerType]
  );

  // 최초 진입 이후의 위치 갱신은 지도를 다시 그리지 않고 마커만 옮긴다.
  useEffect(() => {
    if (!currentLocationForMap) return;
    webviewRef.current?.injectJavaScript(
      `if (window.updateCurrentLocation) { window.updateCurrentLocation(${currentLocationForMap.latitude}, ${currentLocationForMap.longitude}); } true;`
    );
  }, [currentLocationForMap]);

  const mapKey = `${routeId}-${coordinates.length}-${navSegData.length}-${routeSegments.length}`;

  const handleEndNavigation = () => {
    Alert.alert("안내 종료", "길안내를 종료할까요?", [
      { text: "취소", style: "cancel" },
      {
        text: "종료",
        style: "destructive",
        onPress: async () => {
          // GPS 구독 즉시 해제 — 느림 현상 해소
          subscriptionRef.current?.remove();
          subscriptionRef.current = null;

          // 지도(WebView)를 즉시 내려 대용량 navigation_segments/waypoints
          // 배열 참조를 바로 해제 — 화면 전환 중 불필요한 렌더링 비용 제거
          setNavEnded(true);

          const now = Date.now();
          const totalDurationMs = now - startTimeRef.current;

          // 측정 파이프라인 v2 — 마지막 measurementUnit까지 GPS로 실제 통과했는지.
          // "안내 종료" 버튼은 도착 후에 눌러도 도중에 눌러도 항상 이 핸들러를
          // 타므로(위 주석 참고), 도착 여부는 버튼을 누른 게 아니라 currentUnitIdxRef
          // 가 끝까지 갔는지로 판정한다. measurementUnits가 비어 있으면(BE
          // build_measurement_units 실패 — 위 경고 로그) 0 >= 0 이 참이 되어
          // "도착"으로 오판하므로 length > 0 가드를 먼저 건다.
          const reachedDestination =
            measurementUnits.length > 0 && currentUnitIdxRef.current >= measurementUnits.length;

          // 개인화 계측 — 진행 중이던 마지막 bin(부분 통과)을 관측 1행으로 확정하고
          // 세션 종료 플러시. 개별 POST 없이 /collect/batch 로만 나간다(인계 §5 ⑫).
          const cs = collectSessionRef.current;
          if (cs) {
            const finalObs = distanceRowTrackerRef.current?.finalize(now, serverRouteIdRef.current) ?? [];
            for (const obs of finalObs) cs.addSlopeObservation(buildSlopeObservationPayload(obs));
            cs.flush({ final: true }).catch(() => {});
            collectSessionRef.current = null;
            distanceRowTrackerRef.current = null;
          }
          if (gpsTraceBufferRef.current) {
            gpsTraceBufferRef.current.flush({ final: true }).catch(() => {});
            gpsTraceBufferRef.current = null;
          }

          // 도중에 종료해도, 실제로 GPS 로 끝점까지 통과한 구간만 저장한다(옵션 b).
          // 종료 순간 밟고 있던 구간은 "부분 통과"라 소요시간을 만들지 않고 버린다.
          // 안 지나온 구간에 가짜 시간을 채워 넣던 예전 방식이 기록에 "0초 · 좋음"
          // 유령 구간을 남기던 문제를 없앤다 — 모아진 것만 남긴다.
          const segments: SegmentTime[] = [];
          routeSegments.forEach((seg, i) => {
            const measured = measuredMsRef.current[i];
            if (measured == null) return; // 미통과·부분통과 → 저장 안 함
            if (seg.outsideSeoul) return; // 서울 밖(경사 데이터 없음) → 판단 구간 제외
            segments.push({
              index: i,
              distanceM: seg.length ?? 5,
              slopePercent: seg.slope ?? 0,
              elapsedMs: measured,
              measured: true,
              zone: seg.zone,
              start: seg.start,
              end: seg.end,
            });
          });

          const newId = generateId();
          savedRouteIdRef.current = newId;
          setSavedRouteId(newId);
          const record: RouteRecord = {
            id: newId, from, to, mode: (mode as any) ?? "walk", walkerType,
            date: new Date().toISOString(), totalDurationMs, segments,
          };
          // 로컬 저장만 대기 (구간평가 화면에서 savedRouteId를 바로 참조하므로 필요) —
          // AsyncStorage 로컬 쓰기는 네트워크와 달리 빠르다.
          await saveRoute(record);

          // 서버 동기화(최대 수천 건의 구간 업로드 포함)는 화면 전환/다음 구간
          // 진행과 무관하게 백그라운드에서 처리해 종료 버튼 응답이 지연되지 않도록 한다.
          const syncToServer = async () => {
            try {
              const token = await getAuthToken();
              const rid   = serverRouteIdRef.current;
              if (token && rid !== null) {
                // 통과한 구간은 지나는 시점에 이미 실시간 업로드됨(submitSegment).
                // 여기선 완료 처리만 — 안 지나온 구간은 서버에도 올리지 않는다.
                await completeNavigation(rid, token, {
                  sessionId: collectSessionIdRef.current ?? collectSessionRef.current?.sessionId,
                  reachedDestination,
                });
                await updateServerRouteId(newId, rid);
              }
            } catch (e) {
              console.log("[FE] 서버 동기화 실패 (로컬 저장 유지):", e);
            }
          };

          // 도보1→도보2 전환은 이제 GPS 도착 자동 감지로 처리한다(위
          // watchPositionAsync 콜백 참고) — "안내 종료"는 어떤 구간에서
          // 누르든 항상 여정 전체를 끝내고 평가 화면으로 이동한다.
          stopAlightReminder();
          syncPromiseRef.current = syncToServer();
          void proceedAfterNavigation();
        },
      },
    ]);
  };

  // 안내 종료 → (전체 경로 만족도 별점 없이) 곧장 구간평가 화면으로.
  // BE 가 completeNavigation 시점에 신호 D 랭킹을 계산하므로 화면 전환 전에
  // 서버 동기화(syncPromiseRef)를 기다린다. 실패해도 진행 — 화면이 GET 재시도한다.
  const proceedAfterNavigation = async () => {
    try { await syncPromiseRef.current; } catch { /* 진행 */ }
    routeAfterRating(navigation, {
      serverRouteId: serverRouteIdRef.current,
      routeSegments,
      measurementUnits,
      // state(savedRouteId)는 이 tick 에 아직 "" — ref 를 우선 사용
      nextRouteId: savedRouteIdRef.current || savedRouteId,
      sessionId: collectSessionIdRef.current ?? collectSessionRef.current?.sessionId,
    });
  };

  // SafeArea 적용 — endBtn / summaryOverlay 하단
  const bottomPad = insets.bottom + 16;

  return (
    <View style={ss.screen}>
      {navEnded ? (
        <View style={[ss.emptyMap, { backgroundColor: C.bg }]} />
      ) : coordinates.length > 0 && KAKAO_JAVASCRIPT_KEY ? (
        <WebView
          ref={webviewRef}
          key={mapKey}
          originWhitelist={["*"]}
          source={{ html: mapHtml }}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mixedContentMode="always"
          style={ss.webView}
        />
      ) : (
        <View style={ss.emptyMap}>
          {isTransitStub ? (
            <>
              <Text style={ss.emptyMapIcon}>🚌</Text>
              <Text style={ss.emptyMapTitle}>이 구간은 도보 안내가 없습니다</Text>
              <Text style={ss.emptyMapText}>
                버스/지하철만으로 이동하는 경로라 GPS로 안내할 도보 구간이 없어요.{"\n"}
                위 여정 안내를 참고해 탑승해 주세요.
              </Text>
            </>
          ) : (
            <>
              <Text style={ss.emptyMapIcon}>🗺</Text>
              <Text style={ss.emptyMapTitle}>경로를 표시할 수 없습니다</Text>
              <Text style={ss.emptyMapText}>
                경로 좌표 또는 카카오 JavaScript 키를 확인해 주세요.
              </Text>
            </>
          )}
          {!!locationError && <Text style={ss.locationError}>{locationError}</Text>}
        </View>
      )}

      <View style={ss.topOverlay}>
        <TouchableOpacity style={ss.backBtn} onPress={() => navigation?.goBack()}>
          <Ionicons name="chevron-back" size={24} color={C.navy} />
        </TouchableOpacity>
        <View style={ss.titleBox}>
          <Text style={ss.title}>{cfg.icon} {cfg.label}</Text>
          <Text style={ss.subTitle} numberOfLines={1}>{from} → {finalDestinationName}</Text>
          {!!stationExitMessage && (
            <Text style={ss.legContext} numberOfLines={1}>🛗 {stationExitMessage}</Text>
          )}
          {finalDestinationName !== to && (
            <Text style={ss.legContext} numberOfLines={1}>
              지금: {to}까지
              {legIndex >= 0 && journeySteps.length > 0 ? ` · ${legIndex + 1}/${journeySteps.length}단계` : ''}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={ss.voiceBtn}
          onPress={() => {
            const next = !voiceEnabled;
            setVoiceEnabled(next);
            if (!next) Speech.stop();
          }}
        >
          <Text style={ss.voiceIcon}>{voiceEnabled ? "🔊" : "🔇"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[ss.voiceBtn, showSlopeMarkers ? ss.slopeBtnActive : ss.slopeBtnOff]}
          onPress={() => {
            const next = !showSlopeMarkers;
            setShowSlopeMarkers(next);
            webviewRef.current?.injectJavaScript(
              `if(window.setSlopeMarkers){window.setSlopeMarkers(${next});}true;`
            );
          }}
        >
          <Text style={[ss.voiceIcon, showSlopeMarkers && ss.slopeIconActive]}>%</Text>
        </TouchableOpacity>
      </View>

      {/* ⑮ 왕복·방향 교대 안내 — 순수 도보 개인화 세션에서만. 대중교통 도보
          leg(mode="transit")에서는 "도착지→출발지" 문구가 무의미하고
          @ando/roundtrip_seq 카운터도 leg마다 증가해버린다 (이슈 R1). */}
      {mode === "walk" && (
        <RoundtripHintBanner from={from} to={finalDestinationName ?? to} />
      )}

      {/* 개인화 데이터 수집 동의 (이슈 #1) — 결정 전 1회, 도보 안내에서만 */}
      <CollectConsentModal
        visible={consentPrompt}
        onDecide={(granted) => {
          setConsentPrompt(false);
          void setCollectConsent(granted);
          if (granted) beginCollection(Date.now());
        }}
      />

      {journeySteps.length > 0 && (
        <View style={[ss.journeyStepper, { bottom: bottomPad + 62 }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={ss.journeyStepperContent}
          >
            {journeySteps.map((step, i) => {
              const isCurrent = i === legIndex;
              return (
                <React.Fragment key={i}>
                  <View style={[ss.journeyStep, isCurrent && ss.journeyStepCurrent]}>
                    <Text style={ss.journeyStepIcon}>{step.icon}</Text>
                    <Text
                      style={[ss.journeyStepLabel, isCurrent && ss.journeyStepLabelCurrent]}
                      numberOfLines={1}
                    >
                      {step.label}
                    </Text>
                    {isCurrent && <Text style={ss.journeyStepBadge}>현재</Text>}
                  </View>
                  {i < journeySteps.length - 1 && (
                    <Text style={ss.journeyStepArrow}>›</Text>
                  )}
                </React.Fragment>
              );
            })}
          </ScrollView>
        </View>
      )}

      {guidance && (
        <View style={ss.guidanceBanner}>
          <Text style={ss.guidanceTurnIcon}>
            {TURN_ICONS[guidance.turn] ?? "↑"}
          </Text>
          <Text style={ss.guidanceText} numberOfLines={2}>
            {guidance.text}
          </Text>
        </View>
      )}

      {!isTransitStub && (
        <View style={ss.routeInfoPanel}>
          <TouchableOpacity
            style={ss.routeInfoToggle}
            onPress={() => setShowRouteInfo((v) => !v)}
            activeOpacity={0.85}
          >
            <Text style={ss.routeInfoToggleText}>
              경로 정보 {showRouteInfo ? "▲" : "ⓘ"}
            </Text>
          </TouchableOpacity>

          {showRouteInfo && (
            <View style={ss.routeInfoCard}>
              <View style={ss.routeInfoRow}>
                <Text style={ss.routeInfoLabel}>예상 시간</Text>
                <Text style={ss.routeInfoValue}>
                  {formatTime(
                    routeData?.totalDistance,
                    walkerType,
                    routeData?.estimatedTimeS ?? routeData?.routes?.[0]?.estimatedTimeS,
                    routeData?.estimated_time_min,
                  )}
                </Text>
              </View>
              <View style={ss.routeInfoRow}>
                <Text style={ss.routeInfoLabel}>거리</Text>
                <Text style={ss.routeInfoValue}>
                  {formatDistance(routeData?.totalDistance ?? routeData?.total_length_m)}
                </Text>
              </View>
              <View style={ss.routeInfoRow}>
                <Text style={ss.routeInfoLabel}>평균 경사</Text>
                <Text style={ss.routeInfoValue}>
                  {formatSlope(routeData?.avgSlope ?? routeData?.avg_slope_pct)}
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      <TouchableOpacity
        style={[ss.endBtn, { bottom: bottomPad }]}
        onPress={handleEndNavigation}
      >
        <Text style={ss.endBtnText}>안내 종료</Text>
      </TouchableOpacity>

    </View>
  );
}

const ss = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: C.bg },
  webView:  { flex: 1, backgroundColor: "#E8EBF0" },

  emptyMap: {
    flex: 1, justifyContent: "center", alignItems: "center",
    paddingHorizontal: 24, backgroundColor: "#E8EBF0",
  },
  emptyMapIcon:  { fontSize: 48 },
  emptyMapTitle: { marginTop: 12, fontSize: 17, fontWeight: "800", color: C.text },
  emptyMapText: {
    marginTop: 8, fontSize: 13, color: C.textSub, textAlign: "center", lineHeight: 19,
  },
  locationError: { marginTop: 12, fontSize: 12, color: C.danger, fontWeight: "700" },

  topOverlay: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 28,
    left: 14, right: 14,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: {
    width: 42, height: 42, borderRadius: 16, backgroundColor: C.white,
    justifyContent: "center", alignItems: "center",
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.14,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  voiceBtn: {
    width: 42, height: 42, borderRadius: 16, backgroundColor: C.white,
    justifyContent: "center", alignItems: "center", marginLeft: 10,
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.14,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },

  voiceIcon: { fontSize: 20 },
  slopeBtnActive: { backgroundColor: C.primary },
  slopeBtnOff: { backgroundColor: '#E4E4EA' },
  slopeIconActive: { color: "#FFFFFF", fontWeight: "800" },

  // 상단 여정 스테퍼 — topOverlay(백버튼 행) 바로 아래, 지도를 최대한 가리지
  // 않도록 40~50px 높이로 제한.
  // bottom은 인라인으로 계산(insets.bottom 반영) — endBtn 바로 위, 예전
  // summaryOverlay 자리로 옮겨왔다.
  journeyStepper: {
    position: "absolute",
    left: 14, right: 14,
    height: 46,
    backgroundColor: C.white,
    borderRadius: 16,
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.14,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  journeyStepperContent: {
    alignItems: "center",
    paddingHorizontal: 12,
    height: 46,
  },
  journeyStep: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    height: 34,
    borderRadius: 10,
  },
  journeyStepCurrent: {
    backgroundColor: C.primary + "18",
  },
  journeyStepIcon: { fontSize: 15 },
  journeyStepLabel: { fontSize: 12, fontWeight: "600", color: C.textSub, maxWidth: 90 },
  journeyStepLabelCurrent: { color: C.primary, fontWeight: "800" },
  journeyStepBadge: {
    fontSize: 9, fontWeight: "800", color: "#FFFFFF",
    backgroundColor: C.primary, borderRadius: 8,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  journeyStepArrow: { fontSize: 16, color: C.textMute, marginHorizontal: 2 },

  titleBox: {
    flex: 1, marginLeft: 10, backgroundColor: C.white,
    borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10,
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.14,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  title:    { fontSize: 15, fontWeight: "900", color: C.text },
  subTitle: { marginTop: 3, fontSize: 12, color: C.textSub },
  legContext: { marginTop: 2, fontSize: 11, fontWeight: "700", color: C.primary },

  guidanceBanner: {
    position: "absolute",
    top: Platform.OS === "ios" ? 124 : 98,
    left: 14,
    // 지도(WebView) 우측 상단의 "접근성 경로 ⓘ" 범례 토글(.legend-toggle:
    // right:12px, top:112px)과 이 배너가 같은 자리에서 겹쳐서, 토글 폭만큼
    // 오른쪽을 비워둔다 — routeInfoPanel이 top:300으로 이 범례를 피한 것과
    // 같은 이유.
    right: 140,
    backgroundColor: "rgba(20,24,31,0.92)",
    borderRadius: 16,
    paddingVertical: 10, paddingHorizontal: 14,
    flexDirection: "row", alignItems: "center", gap: 10,
    elevation: 7, shadowColor: "#000", shadowOpacity: 0.22,
    shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  guidanceTurnIcon: { fontSize: 24, color: "#ffffff", fontWeight: "900" },
  guidanceText:     { flex: 1, fontSize: 13, color: "#ffffff", fontWeight: "700", lineHeight: 19 },

  // 예상시간/거리/평균경사 — 지도 위 "접근성 경로 ⓘ" 범례와 같은 자리(우측
  // 상단)에, 같은 접이식 방식으로 붙인다. 예전엔 하단 전체폭 패널이었다.
  // 지도(WebView) 안의 "접근성 경로 ⓘ" 범례(top:112~약 284, 펼친 상태 기준)
  // 바로 아래, 겹치지 않는 위치에 고정.
  routeInfoPanel: {
    position: "absolute",
    top: 300,
    right: 14,
    alignItems: "flex-end",
    zIndex: 5,
  },
  routeInfoToggle: {
    backgroundColor: "rgba(27,15,74,0.92)",
    borderRadius: 999,
    paddingHorizontal: 13, paddingVertical: 9,
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.22,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  routeInfoToggleText: { fontSize: 12, fontWeight: "800", color: "#FFFFFF" },
  routeInfoCard: {
    marginTop: 8,
    backgroundColor: "rgba(20,24,31,0.9)",
    borderRadius: 14,
    padding: 12,
    minWidth: 140,
    elevation: 5, shadowColor: "#000", shadowOpacity: 0.22,
    shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  routeInfoRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 6,
  },
  routeInfoLabel: { fontSize: 11, color: "rgba(255,255,255,0.6)", fontWeight: "700" },
  routeInfoValue: { fontSize: 12, color: "#FFFFFF", fontWeight: "900", marginLeft: 14 },

  endBtn: {
    position: "absolute", left: 14, right: 14,
    height: 54, borderRadius: 18, backgroundColor: C.danger,
    justifyContent: "center", alignItems: "center",
    elevation: 6, shadowColor: C.danger, shadowOpacity: 0.28,
    shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
  },
  endBtnText: { fontSize: 16, fontWeight: "900", color: C.white },
});
