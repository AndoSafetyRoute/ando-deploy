import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { C } from '../../constants/colors';

const KAKAO_JAVASCRIPT_KEY = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY;

export type MapCoordinate = { latitude: number; longitude: number };

// zone(경사도) 또는 노선(대중교통) 기준으로 구간별 색을 다르게 그리기 위한 조각.
// slopeMean/zone이 있으면(경사 구간) showSlopeMarkers일 때 화살표 라벨도 같이 그린다.
export type MapRouteSegment = {
  coordinates: MapCoordinate[];
  color: string;
  slopeMean?: number;
  zone?: string;
};

export type MapRoute = {
  id: string;
  color: string;
  coordinates: MapCoordinate[];
  // 선택된(selected) 경로일 때만 사용 — 있으면 이 조각들로 색칠하고, 없으면
  // 기존처럼 coordinates 전체를 color 하나로 그린다(비교용 후보 경로는 항상 이쪽).
  segments?: MapRouteSegment[];
};

type Props = {
  routes: MapRoute[];
  selectedRouteId: string;
  startLabel?: string;
  endLabel?: string;
  // 오르막/내리막 퍼센트 화살표 표시 여부. 기본 true.
  showSlopeMarkers?: boolean;
  // 지도 위 토글 버튼에서 on/off를 바꾸고 싶을 때 콜백을 넘겨준다.
  // 없으면(undefined) 버튼 자체를 안 그린다 — 설정 화면 전용으로만 쓰고 싶을 때 대비.
  onToggleSlopeMarkers?: () => void;
};

type HtmlProps = Props & { width: number; height: number };

function escapeHtmlText(text: string) {
  return text.replace(/'/g, "\\'").replace(/\n/g, ' ');
}

function makeRouteMapHtml({ routes, selectedRouteId, startLabel, endLabel, width, height, showSlopeMarkers }: HtmlProps) {
  const selected = routes.find((r) => r.id === selectedRouteId) ?? routes[0];
  const fallback = selected?.coordinates[0] ?? { latitude: 37.5326, longitude: 126.9652 };
  const drawSlopeMarkers = showSlopeMarkers ?? true;

  const routesJson = JSON.stringify(
    routes.map((r) => ({
      id: r.id,
      color: r.color,
      selected: r.id === selectedRouteId,
      path: r.coordinates.map((c) => ({ lat: c.latitude, lng: c.longitude })),
      segments: (r.id === selectedRouteId ? r.segments : undefined)?.map((seg) => ({
        path: seg.coordinates.map((c) => ({ lat: c.latitude, lng: c.longitude })),
        color: seg.color,
        slopeMean: seg.slopeMean,
        zone: seg.zone,
      })),
    }))
  );

  const safeStart = escapeHtmlText(startLabel || '출발');
  const safeEnd = escapeHtmlText(endLabel || '도착');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <style>
          html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; touch-action: none; }
          /* %/fixed 기반 크기는 임베드된 WebView가 자체적으로 재는 뷰포트 크기와
             어긋나는 경우가 있어(특히 목록/탭 전환 직후, 필터바처럼 위에 다른
             UI가 있는 화면에서) RN이 onLayout으로 실측한 픽셀 값을 그대로 박아넣는다. */
          #map { width: ${width}px; height: ${height}px; }
          .label {
            padding: 6px 10px;
            border-radius: 14px;
            background: #ffffff;
            color: #1A1A2E;
            font-size: 12px;
            font-weight: 700;
            box-shadow: 0 2px 8px rgba(0,0,0,0.16);
            white-space: nowrap;
          }
          .slope-arrow {
            font-size: 12px;
            font-weight: 900;
            color: #fff;
            background: rgba(0,0,0,0.55);
            border-radius: 8px;
            padding: 2px 5px;
            white-space: nowrap;
          }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <script type="text/javascript" src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&autoload=false"></script>
        <script>
          var map;
          var bounds;
          var hasBounds = false;

          function fitToBounds() {
            if (!map || !hasBounds) return;
            map.relayout();
            map.setBounds(bounds);
          }

          // 인접 좌표 간 거리가 비정상적으로 먼(오염된) 좌표가 섞여 있으면
          // bounds가 대한해협 건너 일본까지 포함되는 등 지도가 극단적으로
          // 줌아웃되는 문제가 생긴다. bounds 계산에만 이 필터를 적용하고,
          // 실제 그려지는 Polyline 좌표(r.path)는 그대로 둔다.
          function haversineDistance(a, b) {
            var R = 6371000;
            var toRad = function (d) { return (d * Math.PI) / 180; };
            var dLat = toRad(b.lat - a.lat);
            var dLon = toRad(b.lng - a.lng);
            var sinHLat = Math.sin(dLat / 2);
            var sinHLon = Math.sin(dLon / 2);
            var x = sinHLat * sinHLat +
              Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinHLon * sinHLon;
            return 2 * R * Math.asin(Math.sqrt(x));
          }
          var MAX_STEP_M = 500;
          function saneBoundsPoints(path) {
            var sane = [];
            for (var i = 0; i < path.length; i++) {
              var p = path[i];
              var prev = sane[sane.length - 1];
              if (!prev || haversineDistance(prev, p) <= MAX_STEP_M) sane.push(p);
            }
            return sane.length > 0 ? sane : path;
          }

          kakao.maps.load(function () {
            var container = document.getElementById('map');
            map = new kakao.maps.Map(container, {
              center: new kakao.maps.LatLng(${fallback.latitude}, ${fallback.longitude}),
              level: 5,
              draggable: true,
              zoomable: true
            });

            var routes = ${routesJson};
            bounds = new kakao.maps.LatLngBounds();

            routes.forEach(function (r) {
              if (!r.path || r.path.length === 0) return;

              var linePath = r.path.map(function (p) {
                return new kakao.maps.LatLng(p.lat, p.lng);
              });

              if (r.selected && r.segments && r.segments.length > 0) {
                // 구간별 색칠(경사도 zone 또는 대중교통 노선) — 통짜 단색 대신 조각조각 그린다.
                r.segments.forEach(function (seg) {
                  if (!seg.path || seg.path.length < 2) return;
                  var segPath = seg.path.map(function (p) {
                    return new kakao.maps.LatLng(p.lat, p.lng);
                  });
                  new kakao.maps.Polyline({
                    map: map,
                    path: segPath,
                    strokeWeight: 6,
                    strokeColor: seg.color || r.color || '#7C6FF7',
                    strokeOpacity: 1,
                    strokeStyle: 'solid'
                  });

                  if (${drawSlopeMarkers} && seg.zone && seg.zone !== 'flat' && seg.slopeMean && seg.slopeMean !== 0) {
                    var midIdx = Math.floor(segPath.length / 2);
                    var midPt = segPath[midIdx];
                    var arrow = seg.slopeMean > 0 ? '↑' : '↓';
                    var label = arrow + ' ' + Math.abs(seg.slopeMean).toFixed(1) + '%';
                    new kakao.maps.CustomOverlay({
                      position: midPt,
                      content: '<div class="slope-arrow">' + label + '</div>',
                      yAnchor: 1.5
                    }).setMap(map);
                  }
                });
              } else {
                new kakao.maps.Polyline({
                  map: map,
                  path: linePath,
                  strokeWeight: r.selected ? 6 : 4,
                  strokeColor: r.color || '#7C6FF7',
                  strokeOpacity: r.selected ? 1 : 0.35,
                  strokeStyle: 'solid'
                });
              }

              if (r.selected) {
                var boundsPts = saneBoundsPoints(r.path);
                boundsPts.forEach(function (p) {
                  bounds.extend(new kakao.maps.LatLng(p.lat, p.lng));
                  hasBounds = true;
                });

                var startLL = linePath[0];
                var endLL = linePath[linePath.length - 1];

                new kakao.maps.CustomOverlay({
                  position: startLL,
                  content: '<div class="label">🟢 ${safeStart}</div>',
                  yAnchor: 1.6
                }).setMap(map);

                new kakao.maps.CustomOverlay({
                  position: endLL,
                  content: '<div class="label">🔴 ${safeEnd}</div>',
                  yAnchor: 1.6
                }).setMap(map);
              }
            });

            if (hasBounds) {
              // WebView 컨테이너의 실제 크기가 아직 잡히기 전에 setBounds를 호출하면
              // 폭/높이를 작은 값(또는 신뢰할 수 없는 중간값)으로 착각해서 최대로
              // 축소된(한반도 전체) 레벨로 맞춰버린다. 이 값을 안정적으로 감지할
              // 방법이 마땅치 않아서, 언제 실행해도 안전한 fitToBounds를 여러 시점에
              // 걸쳐 반복 호출해 결국엔 올바른 크기로 수렴하게 한다.
              [0, 150, 400, 800, 1500, 2500].forEach(function (delay) {
                setTimeout(fitToBounds, delay);
              });

              // tilesloaded는 줌/드래그로 타일이 새로 로드될 때도 계속 발생한다.
              // 리스너를 계속 살려두면 사용자가 수동으로 줌인해도 곧바로 다시
              // fitToBounds가 원래 범위로 되돌려버려서 "줌이 안 되는" 것처럼 보인다.
              // 초기 레이아웃이 안정될 시간(위 setTimeout 마지막 값과 맞춤)만 듣고
              // 그 이후엔 리스너를 제거해 수동 줌/드래그를 건드리지 않는다.
              if (kakao.maps.event && map) {
                var tilesLoadedHandler = function () { fitToBounds(); };
                kakao.maps.event.addListener(map, 'tilesloaded', tilesLoadedHandler);
                setTimeout(function () {
                  kakao.maps.event.removeListener(map, 'tilesloaded', tilesLoadedHandler);
                }, 3000);
              }
            }
          });

          // postMessage 브릿지 대신 injectJavaScript + window 전역 함수 방식을 쓴다.
          // 이 앱에서 실제로 안정적으로 동작 확인된 유일한 RN→WebView 통신 패턴
          // (HomeScreen의 GPS 이동/카테고리 마커도 동일 방식)이라 이쪽으로 맞춘다.
          window.zoomIn  = function () { if (map) map.setLevel(map.getLevel() - 1); };
          window.zoomOut = function () { if (map) map.setLevel(map.getLevel() + 1); };
          window.refit   = fitToBounds;
        </script>
      </body>
    </html>
  `;
}

export default function RouteMapView({ routes, selectedRouteId, startLabel, endLabel, showSlopeMarkers, onToggleSlopeMarkers }: Props) {
  const webviewRef = useRef<WebView>(null);
  const hasCoordinates = routes.some((r) => r.coordinates.length > 0);
  const [layoutSize, setLayoutSize] = useState<{ width: number; height: number } | null>(null);
  // 대중교통 탭의 하단 시트는 height 애니메이션으로 실제 레이아웃을 바꾸기 때문에,
  // 드래그하는 동안 이 컴포넌트의 onLayout이 프레임마다 재발화된다. 매번 반영하면
  // mapHtml이 계속 바뀌어 WebView가 그때마다 통째로 리로드(카카오 SDK 재요청,
  // map 인스턴스 리셋)되어 시트를 만지작거리는 도중 줌이 먹통이 된다. 레이아웃이
  // 멈춘 뒤(디바운스)에만 반영해서 애니메이션 중 리로드를 막는다.
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
    };
  }, []);

  const mapHtml = useMemo(
    () =>
      layoutSize
        ? makeRouteMapHtml({
            routes,
            selectedRouteId,
            startLabel,
            endLabel,
            showSlopeMarkers,
            width: layoutSize.width,
            height: layoutSize.height,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, selectedRouteId, startLabel, endLabel, showSlopeMarkers, layoutSize?.width, layoutSize?.height]
  );

  if (!hasCoordinates || !KAKAO_JAVASCRIPT_KEY) {
    return (
      <View style={s.emptyMap}>
        <Text style={s.emptyMapIcon}>🗺</Text>
        <Text style={s.emptyMapText}>경로 좌표를 불러오면 지도가 표시됩니다.</Text>
      </View>
    );
  }

  return (
    <View
      style={s.container}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width <= 0 || height <= 0) return;

        if (layoutDebounceRef.current) clearTimeout(layoutDebounceRef.current);
        layoutDebounceRef.current = setTimeout(() => {
          setLayoutSize({ width, height });
        }, 200);
      }}
    >
      {/* RN이 실제 레이아웃 크기를 재기 전에는 WebView를 아예 마운트하지 않는다.
          HTML의 #map 크기를 그 값으로 고정해서 그리기 때문에, 먼저 마운트하면
          알 수 없는(대개 아주 작은) 크기로 렌더되어 최대 축소 레벨로 맞춰진다. */}
      {mapHtml ? (
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          source={{ html: mapHtml }}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          style={s.webView}
          // WebView 내부 console.log는 기본적으로 Metro 터미널에 안 뜨기 때문에
          // (react-native-webview 자체 콘솔 포워딩이 없음), 진단용으로 postMessage
          // 브릿지를 임시로 하나 열어서 RN 쪽 console.log로 확인 가능하게 한다.
          onMessage={(e) => console.log('[RouteMapView][WebView]', e.nativeEvent.data)}
        />
      ) : (
        <View style={s.emptyMap}>
          <ActivityIndicator color={C.textMute} />
        </View>
      )}

      <View style={s.mapControls}>
        <TouchableOpacity
          style={s.mapControlBtn}
          onPress={() => {
            console.log('[RouteMapView] + 버튼 눌림');
            webviewRef.current?.injectJavaScript(
              "var __before = map ? map.getLevel() : null; if(window.zoomIn){window.zoomIn();} var __after = map ? map.getLevel() : null; window.ReactNativeWebView.postMessage('zoomIn: window.zoomIn존재=' + !!window.zoomIn + ' map존재=' + !!map + ' level ' + __before + '→' + __after); true;"
            );
          }}
        >
          <Text style={s.mapControlIcon}>＋</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.mapControlBtn}
          onPress={() => {
            console.log('[RouteMapView] - 버튼 눌림');
            webviewRef.current?.injectJavaScript(
              "var __before = map ? map.getLevel() : null; if(window.zoomOut){window.zoomOut();} var __after = map ? map.getLevel() : null; window.ReactNativeWebView.postMessage('zoomOut: window.zoomOut존재=' + !!window.zoomOut + ' map존재=' + !!map + ' level ' + __before + '→' + __after); true;"
            );
          }}
        >
          <Text style={s.mapControlIcon}>－</Text>
        </TouchableOpacity>
        {onToggleSlopeMarkers && (
          <TouchableOpacity
            style={[
              s.mapControlBtn,
              showSlopeMarkers !== false ? s.mapControlBtnActive : s.mapControlBtnOff,
            ]}
            onPress={onToggleSlopeMarkers}
          >
            <Text style={[s.mapControlIcon, showSlopeMarkers !== false && s.mapControlIconActive]}>%</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, minHeight: 180 },
  webView: { flex: 1, backgroundColor: 'transparent' },

  mapControls: {
    position: 'absolute',
    right: 12,
    top: 12,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: C.white,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  mapControlBtn: {
    // 44dp — 야외 보행 중 터치 오차를 감안한 접근성 최소 타겟 크기.
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  mapControlIcon: { fontSize: 18, fontWeight: '700', color: C.text },
  mapControlBtnActive: { backgroundColor: C.primary },
  mapControlIconActive: { color: C.white },
  mapControlBtnOff: { backgroundColor: '#E4E4EA' },

  emptyMap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#E8EBF0',
    gap: 8,
  },
  emptyMapIcon: { fontSize: 32 },
  emptyMapText: { fontSize: 13, color: C.textMute, textAlign: 'center', paddingHorizontal: 30 },
});
