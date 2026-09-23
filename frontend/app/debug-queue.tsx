// 디버그 전용 — collectQueue.ts 의 로컬 오프라인 큐(@ando/collect_pending)를 화면에서
// 직접 확인/강제 재전송한다. 실기기 필드테스트에서 서버(collect_batch_log)에 세션이
// 하나도 안 찍힌 경우, 그 배치가 폰 로컬에 남아있는지 확인하고 구제하기 위한 용도
// (2026-09-21, 3oygp1h7/ick9j9ax/j39k6jit/1f2abzl0 세션 조사).
import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert, Share } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { drainCollectQueue, getDroppedBatchCount } from "../src/utils/collectQueue";
import type { SlopeObservation } from "../src/api/collect";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";

const PENDING_KEY = "@ando/collect_pending";

type PendingBatch = {
  session_id: string;
  seq: number;
  slope_observations?: SlopeObservation[];
  speed_samples?: unknown[];
  segment_feedback?: unknown[];
  route_choice?: unknown;
  route_profile?: unknown;
};

// 신호 A(trip_slope_observations)와 동일한 컬럼 순서 — 서버 스키마
// (backend/database.py CREATE TABLE trip_slope_observations) 그대로 맞춰서,
// 나중에 CSV를 그 테이블 구조와 바로 대조할 수 있게 한다.
const SLOPE_A_COLUMNS = [
  "session_id", "seq", "row_index", "route_id", "distance_m", "slope_mean",
  "slope_max", "ascent_m", "descent_m", "elapsed_ms", "gps_sample_n",
  "step_delta", "stop_class", "dwell_ms", "moving_ms", "avg_gps_accuracy",
  "device_model", "near_crossing", "facility", "valid", "uncertain_reason",
  "slope_source",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 백엔드 save_collect_batch()는 (uid,session_id,seq) 충돌 시 duplicate:true로
 * 조용히 무시하고 그 배치의 실측 데이터를 저장하지 않는다(database.py:1755).
 * 세션 재사용 시 startSeq를 안 이어받으면(collectQueue.ts CollectSession 생성자
 * 주석 참고) 같은 session_id 안에 seq가 중복되는데, 이 경우 그대로 드레인하면
 * 나중 배치(대개 진짜 실측 데이터)가 유실된다. 큐에 쌓인 순서를 보존한 채
 * 세션별로 seq를 0..n-1로 다시 매겨 충돌을 없앤다 — 배치 내용(관측 데이터)
 * 자체는 건드리지 않는다.
 */
function hasSeqCollision(batches: PendingBatch[]): boolean {
  const seen = new Set<string>();
  for (const b of batches) {
    const key = `${b.session_id}::${b.seq}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function renumberSeqPerSession(batches: PendingBatch[]): PendingBatch[] {
  const nextSeq: Record<string, number> = {};
  return batches.map((b) => {
    const n = nextSeq[b.session_id] ?? 0;
    nextSeq[b.session_id] = n + 1;
    return { ...b, seq: n };
  });
}

function buildSignalACsv(batches: PendingBatch[]): { csv: string; rowCount: number } {
  const rows: string[] = [SLOPE_A_COLUMNS.join(",")];
  let rowCount = 0;
  for (const b of batches) {
    (b.slope_observations ?? []).forEach((o, idx) => {
      rowCount += 1;
      const rec: Record<string, unknown> = {
        session_id: b.session_id, seq: b.seq, row_index: idx, ...o,
      };
      rows.push(SLOPE_A_COLUMNS.map((c) => csvEscape(rec[c])).join(","));
    });
  }
  return { csv: rows.join("\n"), rowCount };
}

export default function DebugQueueScreen() {
  const insets = useSafeAreaInsets();
  const [batches, setBatches] = useState<PendingBatch[] | null>(null);
  const [rawBytes, setRawBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [draining, setDraining] = useState(false);
  const [lastAction, setLastAction] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await AsyncStorage.getItem(PENDING_KEY);
      setRawBytes(raw ? raw.length : 0);
      setBatches(raw ? (JSON.parse(raw) as PendingBatch[]) : []);
    } catch (e: any) {
      setLastAction(`로드 실패: ${String(e?.message ?? e).slice(0, 200)}`);
      setBatches(null);
      setRawBytes(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const handleDrain = async () => {
    setDraining(true);
    setLastAction("재전송 시도 중...");
    try {
      await drainCollectQueue();
      setLastAction(`재전송 시도 완료 (${new Date().toLocaleTimeString("ko-KR")})`);
    } catch (e: any) {
      setLastAction(`재전송 중 에러: ${String(e?.message ?? e).slice(0, 200)}`);
    } finally {
      setDraining(false);
      await load();
    }
  };

  const handleCopyRaw = async () => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_KEY);
      Alert.alert("원본 JSON (앞 800자)", raw ? raw.slice(0, 800) : "(비어있음)");
    } catch (e: any) {
      Alert.alert("읽기 실패", String(e?.message ?? e));
    }
  };

  const handleExportSignalACsv = async () => {
    if (!batches || batches.length === 0) {
      Alert.alert("내보낼 게 없음", "큐가 비어있어 신호 A 데이터가 없어.");
      return;
    }
    const { csv, rowCount } = buildSignalACsv(batches);
    if (rowCount === 0) {
      Alert.alert("신호 A 행 없음", "큐에 배치는 있지만 slope_observations가 비어있어.");
      return;
    }
    try {
      // 기기별 로컬 스토리지에 파일로 안 남기고 OS 공유 시트로 바로 넘긴다 —
      // 필드테스트마다 폰을 바꿔가며 쓸 예정이라, 파일 저장 위치를 기기마다
      // 따로 챙기지 않아도 메일/드라이브/카톡 등으로 그 자리에서 바로 빼낼 수 있게.
      await Share.share({
        title: `signal_a_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`,
        message: csv,
      });
    } catch (e: any) {
      Alert.alert("공유 실패", String(e?.message ?? e).slice(0, 200));
    }
  };

  const handleFixSeqCollisions = async () => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_KEY);
      const list: PendingBatch[] = raw ? JSON.parse(raw) : [];
      if (!hasSeqCollision(list)) {
        Alert.alert("충돌 없음", "session_id+seq 조합이 이미 전부 유일해 — 그냥 재전송해도 안전해.");
        return;
      }
      const fixed = renumberSeqPerSession(list);
      await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(fixed));
      setLastAction("seq 충돌 정리 완료 — 세션별로 0부터 다시 번호 매김. 이제 재전송해도 돼.");
      await load();
    } catch (e: any) {
      Alert.alert("정리 실패", String(e?.message ?? e).slice(0, 200));
    }
  };

  const seqCollision = batches ? hasSeqCollision(batches) : false;
  const dropped = getDroppedBatchCount();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>로컬 수집 큐 (디버그)</Text>
        <TouchableOpacity style={styles.headerIconButton} onPress={load}>
          <Ionicons name="refresh" size={24} color={NAVY} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>@ando/collect_pending</Text>
          <Text style={styles.metaText}>
            {loading ? "불러오는 중..." : `배치 ${batches?.length ?? 0}개 · ${rawBytes ?? 0} bytes`}
          </Text>
          <Text style={styles.metaText}>디스크 저장 실패로 폐기된 배치 누적: {dropped}개</Text>
          {!!lastAction && <Text style={styles.actionText}>{lastAction}</Text>}
        </View>

        {seqCollision && (
          <View style={styles.warnCard}>
            <Text style={styles.warnText}>
              ⚠️ 같은 세션 안에 (session_id, seq) 중복이 있어 — 이대로 재전송하면
              백엔드가 나중 배치를 "중복"으로 조용히 무시해 실측 데이터가 유실돼.
              먼저 아래 "seq 충돌 정리"를 눌러줘.
            </Text>
          </View>
        )}

        {batches && batches.length === 0 && (
          <Text style={styles.emptyText}>
            큐가 비어있음 — 이미 전부 전송됐거나, 애초에 디스크에 저장된 적이 없음
            (savePending 실패로 유실됐을 가능성 포함).
          </Text>
        )}

        {batches?.map((b, i) => (
          <View key={i} style={styles.batchCard}>
            <Text style={styles.batchTitle}>{b.session_id} · seq={b.seq}</Text>
            <Text style={styles.batchRow}>
              slope={b.slope_observations?.length ?? 0}  speed={b.speed_samples?.length ?? 0}{"  "}
              seg={b.segment_feedback?.length ?? 0}  choice={b.route_choice ? "Y" : "N"}{"  "}
              profile={b.route_profile ? "Y" : "N"}
            </Text>
          </View>
        ))}

        {seqCollision && (
          <TouchableOpacity style={styles.actionButton} onPress={handleFixSeqCollisions}>
            <Text style={styles.actionButtonText}>seq 충돌 정리 (세션별로 재번호)</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[
            styles.actionButton,
            (draining || seqCollision) && styles.actionButtonDisabled,
          ]}
          onPress={handleDrain}
          disabled={draining || seqCollision}
        >
          <Text style={styles.actionButtonText}>
            {draining ? "재전송 중..." : "지금 서버로 강제 재전송"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleExportSignalACsv}>
          <Text style={styles.secondaryButtonText}>신호 A CSV로 내보내기 (공유)</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleCopyRaw}>
          <Text style={styles.secondaryButtonText}>원본 JSON 보기 (앞부분)</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const shadowStyle = Platform.select({
  ios: { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  android: { elevation: 4 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", paddingHorizontal: 20 },
  header: { height: 62, marginTop: 18, flexDirection: "row", alignItems: "center" },
  headerIconButton: {
    width: 44, height: 44, borderRadius: 15, backgroundColor: LIGHT_GRAY,
    justifyContent: "center", alignItems: "center",
  },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 18, fontWeight: "800", color: "#111111" },
  scrollContent: { paddingTop: 18, paddingBottom: 60 },
  card: {
    backgroundColor: LIGHT_GRAY, borderRadius: 20, padding: 16, borderWidth: 1,
    borderColor: BORDER_GRAY, marginBottom: 16,
  },
  cardTitle: { fontSize: 15, fontWeight: "800", color: "#111111", marginBottom: 6 },
  metaText: { fontSize: 13, color: TEXT_GRAY, marginTop: 2 },
  actionText: { fontSize: 13, color: NAVY, marginTop: 8, fontWeight: "700" },
  emptyText: { fontSize: 13, color: TEXT_GRAY, lineHeight: 19, marginBottom: 16 },
  warnCard: {
    backgroundColor: "#FFF4E5", borderRadius: 16, padding: 14, marginBottom: 16,
    borderWidth: 1, borderColor: "#F5C177",
  },
  warnText: { fontSize: 13, color: "#8A5A00", lineHeight: 19, fontWeight: "600" },
  batchCard: {
    backgroundColor: "#FFFFFF", borderRadius: 16, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: BORDER_GRAY, ...shadowStyle,
  },
  batchTitle: { fontSize: 14, fontWeight: "800", color: "#111111" },
  batchRow: { fontSize: 12, color: TEXT_GRAY, marginTop: 4 },
  actionButton: {
    marginTop: 8, backgroundColor: NAVY, borderRadius: 18, paddingVertical: 16, alignItems: "center",
  },
  actionButtonDisabled: { opacity: 0.5 },
  actionButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  secondaryButton: {
    marginTop: 12, borderRadius: 18, paddingVertical: 14, alignItems: "center",
    borderWidth: 1, borderColor: BORDER_GRAY,
  },
  secondaryButtonText: { color: NAVY, fontSize: 14, fontWeight: "700" },
});
