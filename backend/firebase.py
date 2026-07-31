import os
import firebase_admin
from firebase_admin import credentials, auth

_initialized = False


def init_firebase():
    global _initialized
    if _initialized:
        return
    key_path = os.environ.get("FIREBASE_KEY_PATH", "firebase-key.json")
    cred = credentials.Certificate(key_path)
    firebase_admin.initialize_app(cred)
    _initialized = True
    print(f"[Auth] Firebase Admin SDK 연결 완료 (key: {key_path})")


def verify_token(id_token: str) -> dict:
    """Firebase ID 토큰 검증 → uid, email, display_name, photo_url 반환"""
    init_firebase()
    # clock_skew_seconds: 서버 시계가 실제 시각보다 몇 초 늦어도(또는 빨라도)
    # "Token used too early" 오류 없이 허용한다. 이 환경의 시계가 NTP 동기화가
    # 안 돼 있어서(관리자 권한 필요, 미해결) 몇 초 단위로 어긋나는 걸 확인함.
    decoded = auth.verify_id_token(id_token, clock_skew_seconds=30)
    return {
        "uid":          decoded["uid"],
        "email":        decoded.get("email", ""),
        "display_name": decoded.get("name", ""),
        "photo_url":    decoded.get("picture", ""),
    }


def delete_firebase_user(uid: str) -> None:
    """회원 탈퇴 — Firebase Authentication에서 계정 자체를 삭제한다."""
    init_firebase()
    auth.delete_user(uid)
