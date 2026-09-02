"""
개인화 코스트 커브 기저함수(B-spline) 사전계산.
ando_dev_final.md 7.3절 — "θ와 무관한 부분은 미리 계산해둔다" 최적화.

personal_cost(e) = Σ_k θ_k · basis_weights[e, k]

θ(사용자별 계수, 15개)는 배치 학습(⑨)에서 나오지만, 엣지별 L_e·B_k(g_e) 값 자체는
그래프 구조(경사·길이)만으로 결정되고 θ와 무관하다. 그래서 서버 시작 시(그래프
로딩 시) 딱 한 번만 계산해두면, 사용자마다 θ가 달라져도 이 사전계산은 재사용하고
행렬-벡터 곱 한 번(θ·basis_weights)만 다시 하면 된다 — 매 요청/배치마다 그래프를
다시 순회할 필요가 없다.

3차(cubic) B-spline은 로컬 서포트라 한 엣지당 최대 4개 기저함수만 0이 아니다.
그래서 (엣지 수 × 15) 전체를 dense로 들고 있을 필요 없이 sparse로 저장한다.
"""
import numpy as np
from scipy.interpolate import BSpline
from scipy.sparse import csr_matrix, save_npz, load_npz

from config import (
    BASIS_N_KNOTS, BASIS_DEGREE, BASIS_G_MIN, BASIS_G_MAX,
    BASIS_CORE_MIN, BASIS_CORE_MAX,
    BASIS_KNOTS_LEFT, BASIS_KNOTS_CORE, BASIS_KNOTS_RIGHT,
)


def _knot_vector(n_bases: int = BASIS_N_KNOTS, degree: int = BASIS_DEGREE,
                  domain: tuple = (BASIS_G_MIN, BASIS_G_MAX)) -> np.ndarray:
    """
    Clamped **비균등** knot vector (열린 매듭열).
    길이 = n_bases + degree + 1 (표준 B-spline 관계식).

    균등 배치하면 도메인(±25%)이 넓어서 관측이 몰리는 코어(±10%)의 커브 해상도가
    형편없어진다(문서 7.1절). 그래서 내부 매듭을 세 구간으로 나눠 코어에 조밀하게
    배치한다: [G_MIN,CORE_MIN] LEFT개 · [CORE_MIN,CORE_MAX] CORE개 · [CORE_MAX,G_MAX]
    RIGHT개 (경계 매듭 공유). 양 끝은 degree번 더 반복해 경계에서 커브가 경계값을
    정확히 지나게 한다(clamped).

    도메인이 (BASIS_G_MIN, BASIS_G_MAX)가 아니면(테스트 등) 비균등 구간 경계를
    도메인 폭에 비례해 스케일한다.
    """
    lo, hi = domain
    if (lo, hi) == (BASIS_G_MIN, BASIS_G_MAX):
        core_lo, core_hi = BASIS_CORE_MIN, BASIS_CORE_MAX
    else:
        # 비표준 도메인: ±25 기준 코어 비율(−10/25, 10/25)을 그대로 적용
        core_lo = lo + (hi - lo) * (BASIS_CORE_MIN - BASIS_G_MIN) / (BASIS_G_MAX - BASIS_G_MIN)
        core_hi = lo + (hi - lo) * (BASIS_CORE_MAX - BASIS_G_MIN) / (BASIS_G_MAX - BASIS_G_MIN)

    left  = np.linspace(lo,      core_lo, BASIS_KNOTS_LEFT)
    core  = np.linspace(core_lo, core_hi, BASIS_KNOTS_CORE)
    right = np.linspace(core_hi, hi,      BASIS_KNOTS_RIGHT)
    interior = np.concatenate([left, core[1:], right[1:]])  # 공유 경계 매듭 dedupe

    expected = n_bases - degree + 1
    if len(interior) != expected:
        raise ValueError(
            f"내부 매듭 수 {len(interior)} != 기대값 {expected} "
            f"(BASIS_KNOTS_LEFT/CORE/RIGHT 합을 확인: "
            f"LEFT + CORE-1 + RIGHT-1 == N_KNOTS - DEGREE + 1)"
        )
    return np.concatenate([
        np.repeat(lo, degree),
        interior,
        np.repeat(hi, degree),
    ])


def basis_matrix(g_values: np.ndarray,
                  n_bases: int = BASIS_N_KNOTS,
                  degree: int = BASIS_DEGREE,
                  domain: tuple = (BASIS_G_MIN, BASIS_G_MAX)) -> csr_matrix:
    """
    g_values(m,) [signed slope %, 오르막 +, 내리막 -] -> (m, n_bases) sparse 행렬.
    도메인 밖 값(±g_max 초과)은 경계로 clip — 실측에서 드물게 나올 극단치가
    행렬 계산을 깨뜨리지 않게 방어.
    """
    t = _knot_vector(n_bases, degree, domain)
    g = np.clip(np.asarray(g_values, dtype=np.float64), domain[0], domain[1])
    # scipy design_matrix는 마지막 매듭점을 half-open 구간으로 취급해 경계값
    # 자체가 정확히 domain[1]이면 범위 밖으로 판정될 수 있어 미세하게 당겨준다.
    eps = 1e-9
    g = np.where(g >= domain[1], domain[1] - eps, g)
    return BSpline.design_matrix(g, t, degree)  # CSR, (m, n_bases), row당 최대 degree+1개 nonzero


def precompute_basis_weights(edge_slope_pct: np.ndarray,
                              edge_length_m: np.ndarray) -> csr_matrix:
    """
    엣지별 L_e · B_k(g_e) 사전계산.

    edge_slope_pct, edge_length_m 은 build_cch_engine()의 `edges` 리스트와
    반드시 같은 순서/인덱싱이어야 한다 (CCHMetric weight 배열과 동일 인덱스 기준
    이어야 나중에 θ·basis_weights 결과를 그대로 CCHMetric.reset()에 넣을 수 있음).

    반환: (m, BASIS_N_KNOTS) sparse 행렬.
    """
    B = basis_matrix(edge_slope_pct)                      # (m, N_KNOTS)
    L = csr_matrix(np.asarray(edge_length_m, dtype=np.float64).reshape(-1, 1))
    return B.multiply(L).tocsr()


def save_basis_weights(basis_weights: csr_matrix, path: str) -> None:
    save_npz(path, basis_weights)


def load_basis_weights(path: str) -> csr_matrix:
    return load_npz(path).tocsr()
