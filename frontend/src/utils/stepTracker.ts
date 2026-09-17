// S1 — 걸음 수 수집 (신호 A/D의 "정지 여부" 판정 보강용, S2 stopClassifier가 사용).
//
// Android 네이티브 구현 확인(node_modules/expo-sensors/android/.../PedometerModule.kt):
// watchStepCount 콜백의 steps 필드는 이미 "구독 시작 시점 기준 누적값"이다
// (stepsAtTheBeginning을 빼고 보냄) — 우리가 따로 기준점을 잡을 필요 없음.
// getStepCountAsync는 iOS 전용(expo-sensors .d.ts에 @platform ios 명시) —
// Android에서 호출하면 안 됨. 그래서 watchStepCount만 쓴다.
//
// 권한: Android ACTIVITY_RECOGNITION. Pedometer.requestPermissionsAsync()가
// 내부적으로 이 권한을 요청한다(같은 native 모듈 확인) — 별도 PermissionsAndroid
// 호출 불필요. 거부/기기 미지원 시 이 트래커의 모든 값은 null — 호출부는 그
// null을 "센서 없음/거부"로 받아들이고 나머지 판정(S2)은 걸음 수 없이 동작해야
// 한다(이 파일은 그 폴백을 강제하지 않는다 — 호출부 책임).
//
// 링버퍼 순수 로직은 utils/stepRingBuffer.ts로 분리(React Native 의존 없음 —
// 헤드리스 테스트 대상). 이 파일은 그 위에 실제 센서 구독만 얹는다.

import { Platform } from "react-native";
import { StepRingBuffer } from "./stepRingBuffer";

export type { StepSample } from "./stepRingBuffer";
export { StepRingBuffer };

type PedometerLike = {
  isAvailableAsync(): Promise<boolean>;
  requestPermissionsAsync(): Promise<{ status: string }>;
  watchStepCount(cb: (r: { steps: number }) => void): { remove(): void };
};

/**
 * 실기기 센서 트래커. 안내 시작 시 start(), 종료/화면 이탈 시 반드시 stop().
 * pedometerImpl을 주입하면 실기기 없이도 이 클래스 자체를 모의할 수 있다
 * (앱 코드는 기본값만 씀 — 테스트에서만 사용).
 */
export class StepTracker {
  private buffer = new StepRingBuffer();
  private subscription: { remove(): void } | null = null;
  private _available = false;
  private pedometer: PedometerLike;

  constructor(pedometerImpl?: PedometerLike) {
    // 기본은 실제 expo-sensors — 동적 require로, 패키지가 없거나(구버전 빌드)
    // 네이티브 모듈이 아직 링크 안 된 개발 클라이언트에서도 import 자체가
    // 앱을 죽이지 않게 한다(다른 옵셔널 네이티브 모듈과 같은 패턴, api.ts 참고).
    if (pedometerImpl) {
      this.pedometer = pedometerImpl;
    } else {
      try {
        const { Pedometer } = require("expo-sensors");
        this.pedometer = Pedometer;
      } catch {
        this.pedometer = {
          isAvailableAsync: async () => false,
          requestPermissionsAsync: async () => ({ status: "denied" }),
          watchStepCount: () => ({ remove() {} }),
        };
      }
    }
  }

  get available(): boolean {
    return this._available;
  }

  /** 반환값: 실제로 걸음 수 수집이 시작됐는지. false여도 던지지 않음(폴백은 호출부 책임). */
  async start(): Promise<boolean> {
    if (Platform.OS === "ios") {
      // iOS도 watchStepCount 지원(문서 확인)하지만 이 프로젝트의 실기기 타겟이
      // Android라 iOS 세부 동작(백그라운드 정책 등)은 검증 범위 밖.
      console.log("[StepTracker] iOS는 watchStepCount 동작 미검증(Android 타겟 프로젝트)");
    }
    try {
      const isAvailable = await this.pedometer.isAvailableAsync();
      if (!isAvailable) {
        console.log("[StepTracker] 기기에 걸음 수 센서 없음 — null fallback");
        return false;
      }
      const { status } = await this.pedometer.requestPermissionsAsync();
      if (status !== "granted") {
        console.log(`[StepTracker] 권한 거부(status=${status}) — null fallback`);
        return false;
      }
      this.subscription = this.pedometer.watchStepCount((r) => {
        this.buffer.push({ t_ms: Date.now(), cumulative: r.steps });
      });
      this._available = true;
      return true;
    } catch (e) {
      console.log("[StepTracker] 시작 실패(무시, null fallback):", e);
      return false;
    }
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = null;
    this._available = false;
  }

  /** 센서 미가용/거부/시작 전이면 항상 null. */
  stepsBetween(t0: number, t1: number): number | null {
    if (!this._available) return null;
    return this.buffer.stepsBetween(t0, t1);
  }
}
