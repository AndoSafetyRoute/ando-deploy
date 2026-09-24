// 카카오맵 Polyline 의 strokeWeight 는 화면 픽셀 고정이라 줌 레벨과 무관하게 같은
// 굵기로 그려진다 — 전체 경로가 보이게 축소된 첫 화면에선 선이 지나치게 두꺼워
// 보였다(확대하면 괜찮음). 지도 HTML(WebView) 안에 이 스크립트를 넣고 경로 선을
// zoomLine(poly, 기본굵기, 최소굵기) 로 등록해 두면, 줌이 바뀔 때마다
// 기본굵기 × 레벨별 배율(최소굵기 이상)로 다시 맞춘다. 기본굵기는 확대(레벨 ≤3) 기준.
export const ZOOM_LINE_SCALE_JS = `
  window.__zoomLines = [];
  function zoomLine(poly, base, min) {
    window.__zoomLines.push({ p: poly, b: base, m: min || 2 });
    return poly;
  }
  // 카카오 레벨: 1(가장 확대) ~ 14(가장 축소)
  function lineScaleForLevel(lv) {
    if (lv <= 3) return 1.0;
    if (lv === 4) return 0.8;
    if (lv === 5) return 0.62;
    if (lv === 6) return 0.5;
    if (lv === 7) return 0.42;
    return 0.36;
  }
  function applyZoomLineWeights(m) {
    if (!m) return;
    var f = lineScaleForLevel(m.getLevel());
    window.__zoomLines.forEach(function (o) {
      o.p.setOptions({ strokeWeight: Math.max(o.m, Math.round(o.b * f)) });
    });
  }
  function bindZoomLineWeights(m) {
    kakao.maps.event.addListener(m, 'zoom_changed', function () { applyZoomLineWeights(m); });
    applyZoomLineWeights(m);
  }
`;
