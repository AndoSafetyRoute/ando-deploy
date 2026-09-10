# ⛔ release_v7 — 사용 금지 (release_v8 로 대체됨)

이 브랜치(`release_v7`)는 **배포하지 마세요.** 이력 보존용으로만 origin 에 올려둔 것입니다.

## 왜 쓰면 안 되나

`release_v7` 은 2026-09-10 A/B/C 프론트 작업 시점의 **미완성 스냅샷**입니다. backend 가
`ando-BE gdy/deploy-v2 @ a380d97` 기준이라 아래 문제를 그대로 가지고 있습니다:

| 문제 | release_v7 | release_v8 |
|---|---|---|
| 서울역 도보경로 15km 우회 버그 | ❌ 있음 | ✅ 수정 |
| `@app.post("/route")` 데코레이터 오배치 → **모든 `/route` 호출 HTTP 422** | ❌ 있음 | ✅ 수정 |
| `requirements.txt` 에 `python-multipart` 없음 → **컨테이너 부팅 크래시** | ❌ 있음 | ✅ 수정 |
| `frontend/eas.json` (EAS 빌드 프로필) | ❌ 없음 | ✅ 복구 |

## 대신 쓸 것

**`release_v8`** — 위 4가지가 전부 해결됐고, 백엔드 전 엔드포인트 로컬 검증 완료.
배포 절차는 `release_v8` 의 **`DEPLOY_v8.md`** 참고.

## 이 파일이 붙은 커밋

`release_v7` 원본 스냅샷은 바로 아래 부모 커밋(`73e9c56`)입니다. 이 커밋은 그 위에
경고 파일만 추가한 것입니다.
