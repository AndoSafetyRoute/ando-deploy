import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { RouteRecord } from './storage';

// 세그먼트(구간) 단위 1행 — route 메타데이터를 각 행에 반복 포함하는 tidy/long
// 포맷. route 요약만 필요하면 seg_index=0인 행만 골라도 route 필드는 동일하게
// 반복돼 있어 그대로 groupby 가능. 컬럼 순서는 debug-queue.tsx가 백엔드 스키마
// (navigation_segments)에 맞춘 관례를 따른다.
const ROUTE_CSV_COLUMNS = [
  'route_id', 'date', 'mode', 'walker_type', 'from', 'to',
  'total_duration_ms', 'satisfaction',
  'seg_index', 'distance_m', 'slope_pct', 'elapsed_ms',
  'direction', 'zone', 'name', 'measured',
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** RouteRecord.segments는 로컬 저장 타입이라 zone/name/direction/measured가 선언돼
 *  있지 않지만, 서버에서 받아온 원본 필드는 스프레드로 실제 값에 남아있을 수 있어
 *  any로 느슨하게 읽는다. 없으면 빈 값으로 CSV에 남는다. */
export function buildRoutesCsv(routes: RouteRecord[]): string {
  const rows: string[] = [ROUTE_CSV_COLUMNS.join(',')];

  for (const route of routes) {
    const r = route as any;
    const base = {
      route_id:          r.serverRouteId ?? r.id ?? '',
      date:              r.date ?? '',
      mode:              r.mode ?? '',
      walker_type:       r.walkerType ?? '',
      from:              r.from ?? '',
      to:                r.to ?? '',
      total_duration_ms: r.totalDurationMs ?? '',
      satisfaction:      r.satisfaction ?? '',
    };

    const segments = route.segments ?? [];

    if (segments.length === 0) {
      const rec: Record<string, unknown> = {
        ...base,
        seg_index: '', distance_m: '', slope_pct: '', elapsed_ms: '',
        direction: '', zone: '', name: '', measured: '',
      };
      rows.push(ROUTE_CSV_COLUMNS.map((c) => csvEscape(rec[c])).join(','));
      continue;
    }

    for (const seg of segments) {
      const s = seg as any;
      const rec: Record<string, unknown> = {
        ...base,
        seg_index:  s.index,
        distance_m: s.distanceM,
        slope_pct:  s.slopePercent,
        elapsed_ms: s.elapsedMs,
        direction:  s.direction ?? '',
        zone:       s.zone ?? '',
        name:       s.name ?? '',
        measured:   s.measured ?? '',
      };
      rows.push(ROUTE_CSV_COLUMNS.map((c) => csvEscape(rec[c])).join(','));
    }
  }

  return rows.join('\n');
}

/** 마이페이지 "지난 경로" 전체를 유저 1명당 표 1개(csv) 로 내보내 OS 공유 시트로
 *  전달한다. 텍스트를 그대로 공유(react-native Share)하는 대신 실제 .csv 파일을
 *  캐시에 써서 공유하므로, 받는 앱(카카오톡/드라이브/메일 등)에 파일 첨부로
 *  정상 전달된다. */
export async function exportRoutesCsv(routes: RouteRecord[]): Promise<{ ok: true } | { ok: false; reason: 'empty' | 'unavailable' | 'error'; message?: string }> {
  if (routes.length === 0) return { ok: false, reason: 'empty' };

  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return { ok: false, reason: 'unavailable' };

    const csv = buildRoutesCsv(routes);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = new File(Paths.cache, `ando_routes_${stamp}.csv`);
    file.create({ overwrite: true });
    file.write(csv);

    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/csv',
      dialogTitle: '경로 기록 CSV 내보내기',
      UTI: 'public.comma-separated-values-text',
    });

    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: String(e?.message ?? e) };
  }
}
