"""
개인 맞춤 CCHMetric 캐시 관리자. ando_dev_final.md 7.3/8절 (⑧).

절대 규칙 (8절 "요청 경로에서 학습 금지"와 짝을 이루는 규칙):
  캐시에 들어있는 CCHMetric 객체에는 절대로 .reset()을 직접 호출하지 않는다.
  /route 핸들러는 FastAPI 스레드풀에서 동기(def)로 돌기 때문에, 어떤 요청이
  이 metric으로 CCHQuery를 실행하는 도중에 다른 스레드가 .reset()을 부르면
  레이스 컨디션이 난다 (routingkit_cch 문서: "Requires that no CCHQuery /
  CCHOneToMany / CCHManyToOne is alive"). 그래서 갱신할 때는 항상 새
  CCHMetric 객체를 만들고, 캐시 딕셔너리의 포인터만 교체한다 — CPython에서
  딕셔너리 항목 재할당은 원자적이라, 교체 순간에 이미 이전 객체로 쿼리 중이던
  요청은 그 객체를 끝까지 안전하게 계속 참조하고, 그 이후 새로 들어오는
  요청부터 새 metric을 받는다.

이 파일 자체는 θ를 학습하지 않는다. θ는 배치 스크립트(⑨, 5세션마다/야간 배치)가
만들고, 여기 update()에 넘겨주기만 한다.
"""
import threading
import time

import numpy as np


class PersonalMetricCache:
    """
    uid -> CCHMetric 인메모리 캐시. 스레드 세이프(다중 스레드 read/write 모두).

    weights_from_theta()의 θ·basis_weights 결합 공식은 ando_dev_final.md 7.3절
    "personal edge cost = Σ θ_k·[L_e·B_k(g_e)]"을 그대로 따른 것 — 별도 거리항
    없이 이 값 자체가 엣지 가중치다(다른 metric들처럼 거리에 더하는 방식이 아님).
    ⚠️ 실제 배치 학습(⑨) 코드가 나오면 θ의 스케일/부호 컨벤션이 이 가정과
    맞는지 반드시 다영님과 재확인 필요 — 안 맞으면 weights_from_theta()만
    고치면 되고 캐시/스왑 로직은 그대로 재사용 가능하다.
    """

    def __init__(self, cch, basis_weights, weight_scale: float = 1000.0):
        self._cch            = cch
        self._basis_weights  = basis_weights   # scipy sparse (m, N_KNOTS)
        self._weight_scale   = weight_scale
        self._store: dict     = {}   # uid -> CCHMetric
        self._updated_at: dict = {}  # uid -> epoch seconds
        self._lock = threading.Lock()

    # ── 조회 (요청 경로에서 호출 — 읽기 전용, 학습 없음) ──────────────────────

    def get(self, uid: str):
        """캐시에 없으면 None — 호출측이 콜드스타트(문헌 기본 커브)로 폴백해야 함."""
        return self._store.get(uid)

    def has(self, uid: str) -> bool:
        return uid in self._store

    def stats(self) -> dict:
        with self._lock:
            return {
                "cached_users": len(self._store),
                "oldest_update": min(self._updated_at.values()) if self._updated_at else None,
                "newest_update": max(self._updated_at.values()) if self._updated_at else None,
            }

    # ── 갱신 (배치 스크립트 ⑨ 전용 — 요청 경로에서 절대 호출 금지) ────────────

    def weights_from_theta(self, theta) -> list:
        """
        θ(N_KNOTS,) -> CCHMetric에 넣을 정수 가중치 list.
        CCH가 0/음수 가중치를 못 받아들이므로 최소 1로 clip한다.
        """
        theta = np.asarray(theta, dtype=np.float64)
        n_bases = self._basis_weights.shape[1]
        if theta.shape != (n_bases,):
            raise ValueError(f"theta 크기 불일치: {theta.shape}, 기대값 ({n_bases},)")

        raw    = self._basis_weights.dot(theta)   # (m,) float64
        scaled = raw * self._weight_scale
        return np.maximum(1, scaled).astype(np.int64).tolist()

    def update(self, uid: str, theta) -> None:
        """
        새 CCHMetric을 만들어 캐시에 넣는다 (기존 캐시 객체의 .reset() 절대 금지 — 위 설명 참고).
        배치 스크립트(⑨)에서만 호출.
        """
        from routingkit_cch import CCHMetric
        weights    = self.weights_from_theta(theta)
        new_metric = CCHMetric(self._cch, weights)   # 항상 새 객체
        with self._lock:
            self._store[uid]      = new_metric        # 포인터만 교체 (원자적)
            self._updated_at[uid] = time.time()

    def update_weights(self, uid: str, weights: list) -> None:
        """
        S8 — 이미 계산된 엣지 가중치(CCHEngine.personal_weights)로 새 CCHMetric 을
        만들어 캐시에 넣는다. θ·basis 선형결합이 아닌 비선형 c_u(e)(A+D 모델)용.
        update() 와 같은 규칙: 항상 새 객체, 포인터만 교체.
        """
        from routingkit_cch import CCHMetric
        new_metric = CCHMetric(self._cch, weights)
        with self._lock:
            self._store[uid]      = new_metric
            self._updated_at[uid] = time.time()

    def evict(self, uid: str) -> None:
        with self._lock:
            self._store.pop(uid, None)
            self._updated_at.pop(uid, None)
