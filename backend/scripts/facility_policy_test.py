"""
S7 회귀 테스트 — 시설 정책(계단 차단) + 출구 선택(에스컬레이터 방향·경로비용).

실 그래프 없이 합성 그래프/합성 시설 데이터로 순수 로직만 검증한다(segments_
hysteresis_test.py와 동일 패턴). 실 서울 그래프·실제 지하철 CSV 데이터를 쓰는
검증(AMBUL 실제 OD 3개 이상)은 이 스크립트 범위 밖 — 이 로컬 dev 환경엔
subway_data/ 가 없어(SUBWAY_DATA_DIR 미설정 + ando-deploy 리포에 폴더 자체가
없음) 실제 역 이름으로는 출구 데이터가 항상 비어 있다. 그래프 쪽은 실 서울
그래프로 직접 확인함(아래 참고, 이 스크립트로 재현 안 됨 — 로드 비용 큼).

실행: PYTHONPATH=. python scripts/facility_policy_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import networkx as nx

from config import FORBIDDEN_PENALTY
from routing.cost import USER_TYPES, is_facility_blocked, is_facility_blocked_for_any_type, set_edge_weights
from routing.measurement_units import build_measurement_units
from routing.segments import build_navigation_segments
import subway.facility as facility


def _make_stairs_graph() -> nx.DiGraph:
    """a-b(계단)-c: 30m 지름길 / a-d-e-c: 50m 평지 우회. 양방향."""
    G = nx.DiGraph()
    edges = [
        ("a", "b", 15.0, 5.0, "steps"), ("b", "a", 15.0, -5.0, "steps"),
        ("b", "c", 15.0, 1.0, "footway"), ("c", "b", 15.0, -1.0, "footway"),
        ("a", "d", 20.0, 0.5, "footway"), ("d", "a", 20.0, -0.5, "footway"),
        ("d", "e", 15.0, 0.5, "footway"), ("e", "d", 15.0, -0.5, "footway"),
        ("e", "c", 15.0, 0.5, "footway"), ("c", "e", 15.0, -0.5, "footway"),
    ]
    for u, v, length, slope, hw in edges:
        G.add_edge(u, v, length_m=length, slope_pct=slope, highway=hw)
    for n, lon, lat in [("a", 127.0, 37.5), ("b", 127.0002, 37.5), ("c", 127.0004, 37.5),
                         ("d", 127.0, 37.502), ("e", 127.0004, 37.502)]:
        G.add_node(n, lon=lon, lat=lat)
    return G


def test_is_facility_blocked_matrix():
    for ut in USER_TYPES:
        assert is_facility_blocked(ut, True) is True, f"{ut}: 계단이 차단 안 됨"
        assert is_facility_blocked(ut, False) is False, f"{ut}: 계단 아닌데 차단됨"
    assert is_facility_blocked_for_any_type(True) is True
    assert is_facility_blocked_for_any_type(False) is False
    print("[0] is_facility_blocked 6개 유형 전부 계단 차단, 비계단은 무영향")


def test_set_edge_weights_penalizes_regardless_of_alpha():
    """S7 요구: 세 비용 함수(shortest=alpha0 / type=alpha1) 모두 시설 정책 적용."""
    G = nx.DiGraph()
    G.add_edge("x", "y", length_m=10.0, slope_pct=1.0, highway="steps")
    G.add_edge("x", "z", length_m=10.0, slope_pct=1.0, highway="footway")
    for ut in USER_TYPES:
        for alpha in (0.0, 1.0):
            set_edge_weights(G, ut, alpha=alpha)
            assert G["x"]["y"]["weight"] >= FORBIDDEN_PENALTY * 10.0 * 0.99, (ut, alpha)
            assert G["x"]["z"]["weight"] < FORBIDDEN_PENALTY * 10.0, (ut, alpha)
    print("[1] set_edge_weights: alpha=0(shortest)/alpha=1(type) 둘 다 계단 페널티 적용")


def test_dijkstra_avoids_stairs_all_types_both_modes():
    """find_route()는 그대로 쓰지 않는다 — best_origin_node()가 "목적지에 가장
    가까운 노드로 스냅"하는 로직이라, 이 정도로 작은 합성 그래프(전체가 지름
    200m 반경 안)에서는 출발점이 목적지 바로 옆 노드로 통째로 스냅돼버려
    실제 경로 계산 자체가 스킵된다(실 서울 그래프처럼 훨씬 조밀할 땐 문제
    없음 — 이 세션에서 실 그래프로 별도 확인, 아래 참고). 그래서 set_edge_
    weights()가 실제로 만드는 가중치로 다익스트라를 직접 돌려 "계단 회피"라는
    핵심 로직만 노드 스냅과 분리해 검증한다."""
    G = _make_stairs_graph()
    for ut in USER_TYPES:
        for alpha in (0.0, 1.0):   # 0.0=shortest, 1.0=type(accessibility) 상당
            set_edge_weights(G, ut, alpha=alpha)
            path = nx.dijkstra_path(G, "a", "c", weight="weight")
            assert "b" not in path, (ut, alpha, path)
    print("[2] dijkstra(set_edge_weights 가중치): 6개 유형 × alpha 0/1 전부 계단 우회 확인")


def test_regression_non_stairs_route_unaffected():
    """계단이 전혀 없는 그래프에서는 이번 변경 전/후 가중치가 완전히 같아야 한다
    (is_facility_blocked가 항상 False → 기존 length + alpha*(w1-length) 그대로)."""
    G = nx.DiGraph()
    G.add_edge("p", "q", length_m=12.0, slope_pct=3.0, highway="footway")
    for ut in USER_TYPES:
        for alpha in (0.0, 0.5, 1.0):
            set_edge_weights(G, ut, alpha=alpha)
            w_new = G["p"]["q"]["weight"]
            from routing.cost import slope_cost
            w1 = slope_cost(3.0, ut, 12.0)
            w_old = 12.0 + alpha * (w1 - 12.0)
            assert abs(w_new - w_old) < 1e-9, (ut, alpha, w_new, w_old)
    print("[3] 회귀: 계단 없는 엣지는 이전 공식과 완전히 동일(부동소수 오차 이내)")


def test_measurement_units_and_segments_expose_is_stairs():
    G = _make_stairs_graph()
    path = ["a", "b", "c"]
    units = build_measurement_units(G, path, min_distance_m=30.0)
    segs = build_navigation_segments(G, path, user_type="elderly", min_length_m=30.0)
    assert any(u.is_stairs for u in units)
    assert any(s.is_stairs for s in segs)
    print("[4] measurement_units/segments: is_stairs 전파 확인")


def _facility_db_with(elev=None, esc=None) -> facility.SubwayFacilityDB:
    db = facility.SubwayFacilityDB.__new__(facility.SubwayFacilityDB)
    db._elev = elev or {}
    db._esc = esc or {}
    db._lift = {}
    return db


def test_escalator_direction_filter():
    facility.get_broken_serials = lambda: set()
    facility._kakao_exit_coord = lambda station, exit_no: (37.5, 127.0 + int(exit_no) * 0.001)

    db = _facility_db_with(esc={
        "테스트역": [
            {"type": "escalator", "exit_no": "2", "direction": "상행", "section": "", "serial": "S1"},
            {"type": "escalator", "exit_no": "3", "direction": "하행", "section": "", "serial": "S2"},
        ]
    })

    entering = db.get_exit_candidates("테스트역", "elderly", direction="entering")
    assert [c["exit_no"] for c in entering] == ["3"], entering
    exiting = db.get_exit_candidates("테스트역", "elderly", direction="exiting")
    assert [c["exit_no"] for c in exiting] == ["2"], exiting
    print("[5] 에스컬레이터 방향 필터: entering→하행만, exiting→상행만 (역방향 미사용 확인)")


def test_unknown_direction_kept_as_candidate():
    facility.get_broken_serials = lambda: set()
    facility._kakao_exit_coord = lambda station, exit_no: (37.5, 127.0 + int(exit_no) * 0.001)
    db = _facility_db_with(esc={
        "테스트역2": [{"type": "escalator", "exit_no": "5", "direction": "", "section": "", "serial": "S9"}]
    })
    for d in ("entering", "exiting"):
        c = db.get_exit_candidates("테스트역2", "elderly", direction=d)
        assert [x["exit_no"] for x in c] == ["5"], (d, c)
    print("[6] 방향 미상(빈 값) 에스컬레이터는 양방향 후보로 유지(결측≠역방향)")


def test_wheelchair_ignores_direction():
    facility.get_broken_serials = lambda: set()
    facility._kakao_exit_coord = lambda station, exit_no: (37.5, 127.0 + int(exit_no) * 0.001)
    db = _facility_db_with(elev={
        "테스트역3": [{"type": "elevator", "exit_no": "1", "section": "", "serial": "E1"}]
    })
    for d in ("entering", "exiting"):
        c = db.get_exit_candidates("테스트역3", "manual_wheelchair", direction=d)
        assert [x["exit_no"] for x in c] == ["1"], (d, c)
    print("[7] 휠체어 유형은 방향 무관 엘리베이터만 후보")


def test_get_best_exit_nearest_and_message():
    facility.get_broken_serials = lambda: set()
    facility._kakao_exit_coord = lambda station, exit_no: (37.5, 127.0 + int(exit_no) * 0.001)
    db = _facility_db_with(
        elev={"역": [{"type": "elevator", "exit_no": "1", "section": "", "serial": "E1"}]},
        esc={"역": [{"type": "escalator", "exit_no": "3", "direction": "하행", "section": "", "serial": "S2"}]},
    )
    best = db.get_best_exit("역", "elderly", 37.5, 127.0, direction="entering")
    assert best["exit_no"] == "3" and "하행" in best["message"]
    best_w = db.get_best_exit("역", "manual_wheelchair", 37.5, 127.0)
    assert best_w["exit_no"] == "1" and "엘리베이터" in best_w["message"]
    print("[8] get_best_exit: 최근접 선택 + 안내 문구 정상")


if __name__ == "__main__":
    test_is_facility_blocked_matrix()
    test_set_edge_weights_penalizes_regardless_of_alpha()
    test_dijkstra_avoids_stairs_all_types_both_modes()
    test_regression_non_stairs_route_unaffected()
    test_measurement_units_and_segments_expose_is_stairs()
    test_escalator_direction_filter()
    test_unknown_direction_kept_as_candidate()
    test_wheelchair_ignores_direction()
    test_get_best_exit_nearest_and_message()
    print("\nALL OK")
    print(
        "\n[참고] 실 서울 그래프(cch_engine.py 포함) 계단 회피는 이 세션에서 실제로 "
        "/route 호출로 확인함(user_type=cane, 서울역 인근, navigation_segments/"
        "measurement_units 전부 is_stairs=false, 566m 경로). 이 스크립트로는 "
        "재현하지 않음(그래프 로드 비용 큼). 실제 역 데이터를 이용한 출구선택 "
        "회귀(AMBUL OD 3개+)는 이 로컬 환경에 subway_data/가 없어 미실행 — "
        "SUBWAY_DATA_DIR을 실데이터 경로로 맞춘 뒤 재실행 필요."
    )
