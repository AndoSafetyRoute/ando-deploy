"""
유형 점수(경사비용)에 의한 우회 정도 측정.

6개 유형 각각에 대해 /route candidates=compare 를 호출하고
  - 유형별 경로 길이(routes[0].totalDistance)
  - 평균 경사 / 추정 소요시간
  - 순수 최단거리(CCH, routingComparison.shortest_cch) 대비 우회율
을 표로 출력한다.

  python scripts/detour_probe.py [BASE_URL]
"""
import json
import sys
import urllib.request

BASE_URL = "http://localhost:5000"

USER_TYPES = ["manual_wheelchair", "electric_wheelchair", "walker",
              "cane", "leg_injury", "elderly"]

OD_PAIRS = [
    ("서울역→이태원",   (126.9646, 37.5298), (126.9944, 37.5345)),
    ("시청→광화문",     (126.9784, 37.5665), (126.9769, 37.5759)),
    ("여의도→노량진",   (126.9245, 37.5215), (126.9425, 37.5138)),
    ("서울역→강남역",   (126.9707, 37.5547), (127.0276, 37.4979)),
]


def call(origin, dest, user_type):
    body = json.dumps({
        "origin_lon": origin[0], "origin_lat": origin[1],
        "dest_lon": dest[0], "dest_lat": dest[1],
        "user_type": user_type, "candidates": "compare",
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/route", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main():
    global BASE_URL
    if len(sys.argv) > 1:
        BASE_URL = sys.argv[1]
    print(f"BASE_URL={BASE_URL}\n")

    for name, o, d in OD_PAIRS:
        print(f"### {name}")
        hdr = (f"{'user_type':<20}{'shortest_m':>11}{'type_m':>9}{'detour_x':>10}"
               f"{'avgSlope':>10}{'est_min':>9}{'alpha':>7}")
        print(hdr)
        print("-" * len(hdr))
        base = None
        for ut in USER_TYPES:
            try:
                data = call(o, d, ut)
            except Exception as e:
                print(f"{ut:<20} ERROR {e}")
                continue
            rc = data.get("routingComparison") or {}
            sc = rc.get("shortest_cch", {})
            route0 = (data.get("routes") or [{}])[0]
            det = rc.get("detour", {})
            base = sc.get("length_m", base)
            type_m = round(route0.get("totalDistance", 0), 1)
            detour_x = det.get("type_vs_shortest", "-")
            avg_slope = route0.get("avgSlope", rc.get("type", {}).get("avgSlope", "-"))
            est_min = round(route0.get("estimatedTimeS", 0) / 60, 1)
            alpha = rc.get("type", {}).get("used_alpha", "-")
            print(f"{ut:<20}{str(base):>11}{str(type_m):>9}{str(detour_x):>10}"
                  f"{str(avg_slope):>10}{str(est_min):>9}{str(alpha):>7}")
        print()

    print("* detour_x = 유형별 경로 길이 / 순수 최단거리(CCH). 1.00 이면 우회 없음.")
    print("* alpha = 유형 경로가 쓴 경사가중치 비중(1.0=경사최적, <1=우회제한 이진탐색 결과)")


if __name__ == "__main__":
    main()
