// GPS 원본 궤적 배치 전송 — 측정 파이프라인 v2 (routing/measurement_units.py 관련
// 백엔드 작업의 일부). 기존 /collect/batch(신호 A~D, api/collect.ts)와 완전히
// 독립된 엔드포인트 — session_id 문자열 포맷만 같은 걸 공유한다.
//
// 전송/버퍼링/플러시 타이밍은 utils/gpsTraceBuffer.ts 가 담당하고, 이 파일은
// 순수하게 스키마 + HTTP 한 번만 책임진다(api/collect.ts와 동일한 역할 분리).

import { BASE_URL, getAuthToken } from "../api";

export type GpsPoint = {
  seq:        number;
  t_ms:       number;
  lat:        number;
  lon:        number;
  accuracy_m?: number | null;
  speed_mps?:  number | null;
};

export type GpsBatchResponse = { ok: boolean; saved?: number };

/**
 * /collect/gps-batch 로 GPS 포인트 묶음을 전송한다.
 * - 401(인증 만료/미로그인)·네트워크 오류는 throw → 호출부(GpsTraceBuffer)가 버린다
 *   (신호 A~D와 달리 오프라인 재큐잉을 하지 않는다 — gpsTraceBuffer.ts 설계 메모 참고).
 */
export async function postGpsBatch(
  sessionId: string,
  points: GpsPoint[],
  idToken?: string,
): Promise<GpsBatchResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${BASE_URL}/collect/gps-batch`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ session_id: sessionId, points }),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`collect/gps-batch ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as GpsBatchResponse;
  } finally {
    clearTimeout(timer);
  }
}
