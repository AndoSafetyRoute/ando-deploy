export const C = {
  // brand — 홈/설정/즐겨찾기/검색 화면(app/*.tsx)에서 쓰는 NAVY(#1B0F4A) +
  // PRIMARY(#7C6FF7) 조합과 동일한 톤. primary는 그 화면들의 PRIMARY 상수와
  // 같은 값이라 그대로 두고, 아래 중립 톤(bg/border/textSub/textMute/shadow)만
  // 보라색이 섞이지 않은 회색조로 맞춰서 화면 간 색感 차이를 없앤다.
  primary:      '#7C6FF7',
  primaryDark:  '#5B52D6',
  primaryLight: '#A89BFF',
  primaryBg:    '#F0EEFF',
  navy:         '#1B0F4A',
  white:        '#FFFFFF',
  bg:           '#F1F2F6',
  border:       '#E4E5EA',
  line:         '#E4E5EA',
  text:         '#111111',
  textSub:      '#666666',
  textMute:     '#999999',
  shadow:       'rgba(0,0,0,0.12)',
  danger:       '#FF6B6B',
  success:      '#3DBFA8',
  warn:         '#F5A623',

  // walk route
  route1:       '#7C6FF7',
  route2:       '#3DBFA8',
  route3:       '#F5A623',

  // transit
  subway:       '#3A7BD5',
  subwayBg:     '#E8F0FC',
  bus:          '#2ECC71',
  busBg:        '#E8F9EF',
  // 지도 위 대중교통 탑승 구간 선(先) 색상 전용 — 노선별 브랜드색(subway/bus,
  // 지하철 호선색)을 그대로 쓰면 도보 구간의 경사도 zone 색(ZONE_COLORS,
  // 특히 flat 초록)과 겹쳐 헷갈린다는 피드백으로 무채색으로 분리했다.
  // 뱃지·아이콘 등 목록 UI에는 영향 없음(거긴 계속 subway/bus 브랜드색 사용).
  transitLineBus:    '#8A8A8A',
  transitLineSubway: '#4A4A4A',
  lowFloor:     '#00BFA5',
  lowFloorBg:   '#E0F7F4',
  walk:         '#9E9E9E',
  walkBg:       '#F5F5F5',
  transfer:     '#FF7043',
  elevator:     '#4A90D9',
  elevatorBg:   '#EBF4FF',
  escalator:    '#9B59B6',
  escalatorBg:  '#F3E5F5',
  facility:     '#E67E22',
  facilityBg:   '#FFF3E0',

  // car
  car:          '#4A90D9',
  carBg:        '#EBF4FF',
  parkDisabled: '#7C6FF7',
  parkDisBg:    '#F0EEFF',
  parkGeneral:  '#3A7BD5',
  parkGenBg:    '#E8F0FC',
  dropoff:      '#E67E22',
  dropoffBg:    '#FFF3E0',
  toilet:       '#2ECC71',
  toiletBg:     '#E8F9EF',
  ramp:         '#9B59B6',
  rampBg:       '#F3E5F5',
  trafficGood:  '#2ECC71',
  trafficMid:   '#F5A623',
  trafficBad:   '#FF6B6B',
  taxi:         '#F5A623',
  taxiBg:       '#FFF8E6',
};

// 경사도 zone별 색상 — NavigationScreen(실제 GPS 안내)과 RouteMapView(경로 미리보기)가
// 공유한다. 대중교통 탑승 구간(노선별 브랜드 색) 팔레트와는 톤이 겹치지 않게 분리되어 있다.
export const ZONE_COLORS: Record<string, string> = {
  flat:      '#4CAF50',  // 평지 — 초록
  optimal:   '#FDD835',  // 완만 — 노랑 (기존 파랑은 위험도 상승 순서(초록→노랑→주황→빨강)에서
                          // 벗어나 헷갈린다는 피드백으로 교체)
  warning:   '#FF9800',  // 주의 — 주황
  forbidden: '#F44336',  // 금지 — 빨강
};

// 서울 지하철 공식 노선색(1~9호선). RouteMapView가 지도 위 지하철 탑승 구간
// 중앙선 색으로 쓴다 — 매핑 안 되는 노선(지선/광역철도)은 C.transitLineSubway로 폴백.
export const SUBWAY_LINE_COLORS: Record<string, string> = {
  '1': '#0052A4', '2': '#00A84D', '3': '#EF7C1C', '4': '#00A4E3', '5': '#996CAC',
  '6': '#CD7C2F', '7': '#747F00', '8': '#E6186C', '9': '#BDB092',
};