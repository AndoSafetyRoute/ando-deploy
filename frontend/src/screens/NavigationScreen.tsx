import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Alert,
  Linking,
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
import SatisfactionModal from "../components/SatisfactionModal";
import {
  saveRoute,
  updateSatisfaction,
  updateServerRouteId,
  generateId,
  RouteRecord,
  SegmentTime,
  getShowSlopeMarkers,
  formatMinutes,
} from "../utils/storage";
import {
  getAuthToken,
  startNavigation,
  submitSegment,
  completeNavigation,
  submitFeedback,
  submitZoneObservation,
  ZoneObservationPayload,
} from "../api";
import type { NavSegment, Waypoint } from "../api/routeApi";

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

function getSegmentColor(slope: number) {
  const abs = Math.abs(slope);
  if (abs < 3)                      return "#79C56A";
  if (slope >= 3 && slope < 8)      return "#D96A4E";
  if (slope <= -3 && slope > -8)    return "#5D8FD6";
  if (slope >= 8)                   return "#8B2E24";
  if (slope <= -8)                  return "#284B7C";
  return "#79C56A";
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

const PROXIMITY_THRESHOLD = 15;
// Accuracy.High는 GPS 하드웨어 단독 픽스만 기다려서 실내·건물 인근·GPS
// 신호가 약한 곳에서 첫 위치가 잡히지 않고 무한 대기하는 경우가 있다
// (expo-location Android 알려진 이슈). Balanced는 Wi-Fi/셀룰러 기반
// fused location provider도 함께 써서 훨씬 빠르게 첫 픽스를 준다.
const GPS_WATCH_OPTIONS = {
  accuracy:         Location.Accuracy.Balanced,
  distanceInterval: 5,
  timeInterval:     3000,
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
      color: getSegmentColor(seg.slope),
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
          <div class="legend-row"><span class="legend-line" style="background:#2196F3"></span>완만한 경사</div>
          <div class="legend-row"><span class="legend-line" style="background:#FF9800"></span>주의 구간</div>
          <div class="legend-row"><span class="legend-line" style="background:#F44336"></span>위험 구간</div>
        </div>
        <script type="text/javascript"
          src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&autoload=false">
        </script>
        <script>
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
                new kakao.maps.Polyline({
                  map: map, path: segLatLngs,
                  strokeWeight: 5, strokeColor: seg.color || "#9E9E9E",
                  strokeOpacity: 0.6, strokeStyle: "solid"
                });
              });
            } else if (journeyPath.length > 1) {
              var journeyLatLngs = journeyPath.map(function (p) {
                return new kakao.maps.LatLng(p.lat, p.lng);
              });
              new kakao.maps.Polyline({
                map: map, path: journeyLatLngs,
                strokeWeight: 4, strokeColor: "#9E9E9E",
                strokeOpacity: 0.5, strokeStyle: "shortdash"
              });
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
                new kakao.maps.Polyline({
                  path: polyPath, strokeWeight: 6,
                  strokeColor: seg.color, strokeOpacity: 0.95, strokeStyle: "solid"
                }).setMap(map);

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
                new kakao.maps.Polyline({
                  path: [start, end], strokeWeight: 6,
                  strokeColor: seg.color, strokeOpacity: 0.95, strokeStyle: "solid"
                }).setMap(map);
              });
            } else if (pathData.length > 1) {
              var path = pathData.map(function(p) {
                return new kakao.maps.LatLng(p.lat, p.lng);
              });
              new kakao.maps.Polyline({
                path: path, strokeWeight: 6,
                strokeColor: "#7C6FF7", strokeOpacity: 0.95, strokeStyle: "solid"
              }).setMap(map);
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

            if (currentData) {
              new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(currentData.lat, currentData.lng),
                content:
                  '<div class="current-wrap">' +
                    '<div class="current-dot"></div>' +
                    '<div class="current-label">현재 위치</div>' +
                  '</div>',
                yAnchor: 0.5
              }).setMap(map);
            }

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

  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [locationError,   setLocationError]   = useState("");
  const [showRating,      setShowRating]       = useState(false);
  const [savedRouteId,    setSavedRouteId]     = useState("");
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
  const segmentStartTimesRef = useRef<number[]>([]); // [i] = 구간 i 시작 시각 (ms)
  const currentSegIdxRef     = useRef<number>(0);    // 현재 진행 중인 구간 인덱스
  const measuredMsRef        = useRef<(number | null)[]>([]); // [i] = 구간 i 소요시간, 미측정은 null
  const gpsCallbackCountRef  = useRef<number>(0); // 세그먼트 0 시작 시각 보정용 (2번째 콜백 = 실제 이동 시작)

  // ── zone 전환 추적 refs (방식 C: zone 그룹 단위 소요시간 측정) ─────────────
  // GPS 오차 ±5~10m 에서 5m 구간별 타이밍은 불가 → zone이 바뀌는 시점을 경계로
  // (zone_key, distance_m, elapsed_ms, gps_sample_n) 1행씩 BE에 전송.
  // 이 데이터로 EMA 개인화 속도 프로파일을 업데이트함.
  const zoneKeyRef       = useRef<string>("flat");       // 현재 진행 중인 zone_key
  const zoneStartTimeRef = useRef<number>(Date.now());   // 현재 zone 시작 시각 (ms)
  const zoneDistRef      = useRef<number>(0);            // 현재 zone 누적 거리 (m)
  const zoneGpsNRef      = useRef<number>(0);            // 현재 zone 내 GPS 콜백 횟수
  const zoneSlopeSumRef  = useRef<number>(0);            // 경사도 가중합 (평균 계산용)
  const zoneDistSumRef   = useRef<number>(0);            // 경사도 가중합 분모

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

      const firstZone = routeSegments[0]
        ? getZoneKey(routeSegments[0].zone, routeSegments[0].direction)
        : "flat";
      zoneKeyRef.current       = firstZone;
      zoneStartTimeRef.current = initTime;
      zoneDistRef.current      = 0;
      zoneGpsNRef.current      = 0;
      zoneSlopeSumRef.current  = 0;
      zoneDistSumRef.current   = 0;

      speak(
        `${to}까지 안내를 시작합니다. 총 거리 ${formatDistance(routeData?.totalDistance)}, ` +
        `예상 시간 ${formatTime(routeData?.totalDistance, walkerType, routeData?.estimatedTimeS ?? routeData?.routes?.[0]?.estimatedTimeS)}.`
      );

      // 서버 내비게이션 세션 시작 (best-effort)
      getAuthToken().then(async (token) => {
        if (!token) return;
        try {
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
          });
          serverRouteIdRef.current = route_id;
        } catch (e) {
          console.log("[FE] 내비게이션 세션 시작 실패 (로컬만 유지):", e);
        }
      }).catch(() => {});

      const last = await Location.getLastKnownPositionAsync({});
      if (last && mounted) {
        setCurrentLocation({ latitude: last.coords.latitude, longitude: last.coords.longitude });
      }

      console.log("[GPS] watchPosition 시작");
      subscriptionRef.current = await Location.watchPositionAsync(
        GPS_WATCH_OPTIONS,
        (loc) => {
          if (!mounted) return;

          console.log("[GPS] 위치 수신:", loc.coords.latitude, loc.coords.longitude, "정확도:", loc.coords.accuracy);

          if (gpsWatchdog) { clearTimeout(gpsWatchdog); gpsWatchdog = null; }
          setLocationError((prev) => (prev.startsWith("위치를 찾는 데") ? "" : prev));

          setCurrentLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });

          if (loc.coords.accuracy && loc.coords.accuracy > 20) return;

          const now = Date.now();

          gpsCallbackCountRef.current += 1;
          if (gpsCallbackCountRef.current === 2 && currentSegIdxRef.current === 0) {
            segmentStartTimesRef.current[0] = now;
          }

          zoneGpsNRef.current += 1;

          let curIdx = currentSegIdxRef.current;
          while (curIdx < routeSegments.length) {
            const seg = routeSegments[curIdx];
            const dist = haversineDistance(
              { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
              seg.end
            );
            if (dist >= PROXIMITY_THRESHOLD) break;

            const elapsed = now - segmentStartTimesRef.current[curIdx];
            measuredMsRef.current[curIdx] = elapsed;

            const rid = serverRouteIdRef.current;
            if (rid !== null) {
              const segIdx = curIdx;
              getAuthToken().then((token) => {
                if (!token) return;
                submitSegment(rid, {
                  index: segIdx, distanceM: seg.length ?? 5,
                  slopePercent: seg.slope ?? 0, elapsedMs: elapsed,
                  measured: true, zone: seg.zone, direction: seg.direction,
                }, token).catch(() => {});
              }).catch(() => {});
            }

            const segZoneKey = getZoneKey(seg.zone, seg.direction);
            const segDist    = seg.length ?? 5;
            zoneDistRef.current     += segDist;
            zoneSlopeSumRef.current += Math.abs(seg.slope ?? 0) * segDist;
            zoneDistSumRef.current  += segDist;

            const nextSeg     = curIdx + 1 < routeSegments.length ? routeSegments[curIdx + 1] : null;
            const nextZoneKey = nextSeg ? getZoneKey(nextSeg.zone, nextSeg.direction) : null;
            const isZoneEnd   = nextZoneKey !== zoneKeyRef.current || nextSeg === null;

            if (isZoneEnd && rid !== null) {
              const obs: ZoneObservationPayload = {
                zone_key:      zoneKeyRef.current,
                zone:          seg.zone,
                direction:     seg.direction,
                slope_pct_avg: zoneDistSumRef.current > 0
                  ? zoneSlopeSumRef.current / zoneDistSumRef.current : 0,
                distance_m:    zoneDistRef.current,
                elapsed_ms:    now - zoneStartTimeRef.current,
                gps_sample_n:  zoneGpsNRef.current,
              };
              getAuthToken().then((token) => {
                if (!token) return;
                submitZoneObservation(rid, obs, token);
              }).catch(() => {});

              announceZoneEntry(nextZoneKey);

              // zone 초기화 (다음 zone 시작)
              zoneKeyRef.current       = nextZoneKey ?? "flat";
              zoneStartTimeRef.current = now;
              zoneDistRef.current      = 0;
              zoneGpsNRef.current      = 0;
              zoneSlopeSumRef.current  = 0;
              zoneDistSumRef.current   = 0;
            } else if (segZoneKey !== zoneKeyRef.current) {
              zoneKeyRef.current       = segZoneKey;
              zoneStartTimeRef.current = now;
              zoneDistRef.current      = segDist;
              zoneGpsNRef.current      = 1;
              zoneSlopeSumRef.current  = Math.abs(seg.slope ?? 0) * segDist;
              zoneDistSumRef.current   = segDist;
            }

            curIdx += 1;
            currentSegIdxRef.current = curIdx;
            if (curIdx < routeSegments.length) {
              segmentStartTimesRef.current[curIdx] = now;
            }
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
            navigation?.navigate("Navigation", transitNextLeg.nextLegParams);
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
              Speech.speak(wp.guidance_text, { language: "ko" });
            }
          });
        }
      );
      console.log("[GPS] watchPosition 구독 성공");
      } catch (err: any) {
        console.log("[GPS] 에러:", err?.message ?? err);
        if (mounted) setLocationError("위치 정보를 가져오는 중 오류가 발생했습니다.");
      }
    }

    startLocationWatch();
    return () => {
      mounted = false;
      if (gpsWatchdog) clearTimeout(gpsWatchdog);
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      Speech.stop();
      stopAlightReminder();
    };
  }, []);

  const currentLocationForMap = useMemo(() => {
    if (isLocationNearRoute(currentLocation, coordinates)) return currentLocation;
    return null;
  }, [currentLocation, coordinates]);

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
      }),
    [coordinates, navSegData, routeSegments, currentLocationForMap, from, to, showSlopeMarkers, journeyMapPath, journeyMapSegments, finalDestinationName, finalOriginName]
  );

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

          const curIdx = currentSegIdxRef.current;
          if (curIdx < routeSegments.length && measuredMsRef.current[curIdx] === null) {
            measuredMsRef.current[curIdx] = now - segmentStartTimesRef.current[curIdx];
            currentSegIdxRef.current = curIdx + 1;
          }

          const measuredTotal = (measuredMsRef.current as (number | null)[])
            .filter((v): v is number => v !== null)
            .reduce((s, v) => s + v, 0);
          const unmeasuredDist = routeSegments
            .filter((_, i) => measuredMsRef.current[i] === null)
            .reduce((s, seg) => s + (seg.length ?? 5), 0);
          const remainingMs = Math.max(0, totalDurationMs - measuredTotal);

          const segments: SegmentTime[] = routeSegments.map((seg, i) => {
            const measured = measuredMsRef.current[i];
            if (measured !== null) {
              return {
                index: i, distanceM: seg.length ?? 5, slopePercent: seg.slope ?? 0,
                elapsedMs: measured, measured: true, zone: seg.zone, direction: seg.direction,
              };
            }
            const segDist = seg.length ?? 5;
            return {
              index: i, distanceM: segDist, slopePercent: seg.slope ?? 0,
              elapsedMs: unmeasuredDist > 0
                ? Math.round(remainingMs * (segDist / unmeasuredDist))
                : Math.round(totalDurationMs / Math.max(1, routeSegments.length)),
              measured: false, zone: seg.zone, direction: seg.direction,
            };
          });

          const newId = generateId();
          setSavedRouteId(newId);
          const record: RouteRecord = {
            id: newId, from, to, mode: (mode as any) ?? "walk", walkerType,
            date: new Date().toISOString(), totalDurationMs, segments, satisfaction: null,
          };
          // 로컬 저장만 대기 (평가 팝업에서 savedRouteId를 바로 참조하므로 필요) —
          // AsyncStorage 로컬 쓰기는 네트워크와 달리 빠르다.
          await saveRoute(record);

          // 서버 동기화(최대 수천 건의 구간 업로드 포함)는 화면 전환/다음 구간
          // 진행과 무관하게 백그라운드에서 처리해 종료 버튼 응답이 지연되지 않도록 한다.
          const syncToServer = async () => {
            try {
              const token = await getAuthToken();
              const rid   = serverRouteIdRef.current;
              if (token && rid !== null) {
                const unmeasured = segments.filter((s) => !s.measured);
                await Promise.allSettled(unmeasured.map((s) => submitSegment(rid, s, token)));
                await completeNavigation(rid, totalDurationMs, token);
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
          setShowRating(true);
          syncToServer();
        },
      },
    ]);
  };

  const handleRatingSubmit = async (stars: number) => {
    if (savedRouteId) await updateSatisfaction(savedRouteId, stars);
    try {
      const token = await getAuthToken();
      const rid   = serverRouteIdRef.current;
      if (token && rid !== null) await submitFeedback(rid, stars, token);
    } catch (e) {
      console.log("[FE] 만족도 서버 저장 실패:", e);
    }
    setShowRating(false);
    navigation?.navigate("RouteDetail", { routeId: savedRouteId });
  };

  const handleRatingSkip = () => {
    setShowRating(false);
    navigation?.navigate("RouteDetail", { routeId: savedRouteId });
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

      <SatisfactionModal
        visible={showRating}
        routeFrom={from}
        routeTo={to}
        onSubmit={handleRatingSubmit}
        onSkip={handleRatingSkip}
      />
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
    left: 14, right: 14,
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
