"""
routing/segments.py::apply_zone_hysteresis 순수 로직 검증 (이슈: 경사 시각화 완충 옵션 E).
실 그래프 없이 NavSegment 리스트를 직접 만들어 확인한다.

실행: PYTHONPATH=. python scripts/segments_hysteresis_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routing.segments import NavSegment, apply_zone_hysteresis
from routing.cost import classify_zone, USER_TYPES

USER = "elderly"  # up: g_opt=5.0 g_warn=8.0 / down: g_opt=5.0 g_warn=8.0


def make(*means):
    return [NavSegment(segment_id=i, start_node=(0,), end_node=(0,), slope_mean=m)
            for i, m in enumerate(means)]


def zones(segs):
    return [s.zone for s in segs]


def test_no_hysteresis_baseline_flips():
    # 완충 없이 classify_zone 만 쓰면 4.9/5.1/4.8/5.2 가 경계(5.0)를 넘나들며
    # optimal/warning 을 계속 오간다 — "색이 자주 바뀐다"는 문제 그 자체를 재현.
    means = [4.9, 5.1, 4.8, 5.2, 4.9]
    raw = [classify_zone(m, "up", USER) for m in means]
    assert raw == ["optimal", "warning", "optimal", "warning", "optimal"], raw
    print(f"[0] 완충 없는 raw classify_zone: {raw}  (경계 근처에서 매번 뒤집힘 확인)")


def test_hysteresis_damps_boundary_noise():
    # 같은 4.9/5.1/4.8/5.2/4.9 시퀀스 — 완충 적용하면 5.0±0.75(half) 안에서는
    # 처음 정해진 zone 을 유지해야 한다. 첫 구간(4.9)은 이력 없음 → optimal.
    segs = make(4.9, 5.1, 4.8, 5.2, 4.9)
    apply_zone_hysteresis(segs, USER)
    got = zones(segs)
    assert got == ["optimal"] * 5, got
    print(f"[1] 완충 적용 후: {got}  (전부 optimal 유지 — 깜빡임 제거)")


def test_hysteresis_still_responds_to_real_change():
    # optimal 유지 중이던 게 진짜로 확 나빠지면(9.0%, g_warn 8.0 훌쩍 넘음) 반응해야 한다.
    # 디바운스(ZONE_DWELL_SEGMENTS=2) 때문에 "복귀"도 최소 2구간 이어져야 확정되므로
    # 꼬리를 낮은 값 2개로 둬서(3.0, 2.0) 그 조건을 충족시킨다 — 실제로도 경사가
    # 한 구간만 반짝 낮았다 다시 오르는 경우는 노이즈로 보고 무시하는 게 의도된 동작.
    segs = make(4.9, 5.1, 9.0, 8.5, 3.0, 2.0)
    apply_zone_hysteresis(segs, USER)
    got = zones(segs)
    assert got[0] == "optimal" and got[2] == "forbidden", got
    assert got[3] in ("forbidden", "warning"), got  # 8.5 는 여전히 g_warn 근처 이상
    assert got[5] == "optimal", got  # 3.0/2.0 이 2구간 이어져야 optimal 복귀 확정
    print(f"[2] 진짜 큰 변화엔 반응(디바운스로 복귀엔 2구간 필요): {got}")


def test_direction_change_resets_hysteresis():
    # 오르막(warning 근처) 뒤에 바로 내리막이 오면, 완충 없이 그 방향의 classify_zone
    # 그대로 즉시 적용돼야 한다(방향 전환은 노이즈가 아니라 실제 전환).
    segs = make(7.9, -7.9)  # elderly up warning(5<7.9<=8), down 도 동일 임계
    apply_zone_hysteresis(segs, USER)
    got = zones(segs)
    want0 = classify_zone(7.9, "up", USER)
    want1 = classify_zone(-7.9, "down", USER)
    assert got == [want0, want1], (got, want0, want1)
    print(f"[3] 방향 전환 시 완충 없이 즉시 재분류: {got}")


def test_flat_unaffected():
    segs = make(0.2, -0.3, 0.0)
    apply_zone_hysteresis(segs, USER)
    assert zones(segs) == ["flat", "flat", "flat"], zones(segs)
    print("[4] flat 구간은 항상 flat")


def test_dwell_suppresses_short_blip():
    # optimal 유지 중 딱 1구간만 warning 후보로 튀었다가 바로 optimal 로 돌아오면
    # (경계 히스테리시스로도 못 막을 만큼 큰 값이라도) 디바운스가 그 1구간을 무시해야 한다.
    # elderly down: g_opt=5.0 → -6.0%(warning 후보) 1구간만 낀 시퀀스.
    segs = make(-2.0, -2.5, -6.0, -2.0, -2.5)
    apply_zone_hysteresis(segs, USER)
    got = zones(segs)
    assert got == ["optimal"] * 5, got
    print(f"[6] 1구간만 튀는 후보는 디바운스로 무시: {got}")

    # 반대로 2구간 이상 이어지면(진짜 전환이면) 반영돼야 한다.
    segs2 = make(-2.0, -2.5, -6.0, -6.2, -2.5)
    apply_zone_hysteresis(segs2, USER)
    got2 = zones(segs2)
    assert got2[2] == "warning" and got2[3] == "warning", got2
    print(f"[7] 2구간 이상 이어지면 반영됨: {got2}")


def test_routing_cost_unaffected():
    # 완충은 zone(표시용)만 바꾼다 — slope_score/slope_cost 는 이 모듈과 무관하게
    # 원래 g_opt/g_warn 그대로 계산되는지 간접 확인(순수하게 classify_zone 재호출로
    # 원래 임계값이 그대로인지만 검증 — slope_cost 자체는 cost.py 담당이라 여기선
    # "완충 함수가 classify_zone 의 원본 시그니처/임계값을 안 바꿨다"만 확인).
    assert classify_zone(5.0, "up", USER) == "optimal"
    assert classify_zone(5.1, "up", USER) == "warning"
    print("[5] classify_zone(라우팅이 쓰는 원본 함수)은 그대로")


if __name__ == "__main__":
    test_no_hysteresis_baseline_flips()
    test_hysteresis_damps_boundary_noise()
    test_hysteresis_still_responds_to_real_change()
    test_direction_change_resets_hysteresis()
    test_flat_unaffected()
    test_dwell_suppresses_short_blip()
    test_routing_cost_unaffected()
    print("\nALL OK")
