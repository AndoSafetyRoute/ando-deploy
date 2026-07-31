import React from "react";
import { router, useLocalSearchParams } from "expo-router";
import NavigationScreen from "../src/screens/NavigationScreen";

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function NavigationPage() {
  const params = useLocalSearchParams();

  // 예전엔 routeId/mode/from/to/walkerType/routeData 6개만 골라서 넘겼는데,
  // 그러면 새로 추가되는 파라미터(startLatitude, transitNextLeg, journeySteps,
  // legIndex, journeyMapPath 등)가 여기서 조용히 유실된다 — 실제로 transitNextLeg가
  // 빠지면서 도보1(승차 지점까지) 완료 후 도보2(하차 후)로 자동 전환이 안 되고
  // "도착지가 승차지점으로 보인다"는 문제로 이어졌다. 전부 그대로 넘기고
  // 기본값이 필요한 것만 덧씌운다.
  const forwardedParams: Record<string, string> = {};
  Object.entries(params).forEach(([key, value]) => {
    forwardedParams[key] = getParam(value);
  });

  const routeId = getParam(params.routeId, "-");
  const mode = getParam(params.mode, "walk");
  const from = getParam(params.from, "출발지");
  const to = getParam(params.to, "도착지");
  const walkerType = getParam(params.walkerType, "");
  const routeData = getParam(params.routeData, "");

  const navigationAdapter = {
    goBack: () => router.back(),

    navigate: (screenName: string, screenParams?: Record<string, any>) => {
      // 대중교통 구간 전환(도보1 → 탑승 안내 → 도보2)이 NavigationScreen
      // 안에서 스스로를 다시 호출하는 유일한 케이스라 빠져있었다 — 이게
      // 없으면 기본값(router.push("/"))으로 떨어져 홈으로 튕겨나갔다.
      if (screenName === "Navigation") {
        router.push({
          pathname: "/navigation",
          params: screenParams,
        });
        return;
      }

      if (screenName === "Route") {
        router.push({
          pathname: "/route",
          params: screenParams,
        });
        return;
      }

      if (screenName === "RouteDetail") {
        router.replace({
          pathname: "/route-detail",
          params: screenParams,
        });
        return;
      }

      router.push("/");
    },

    replace: (path: string) => {
      router.replace(path as any);
    },
  };

  return (
    <NavigationScreen
      navigation={navigationAdapter}
      route={{
        params: {
          ...forwardedParams,
          routeId,
          mode,
          from,
          to,
          walkerType,
          routeData,
        },
      }}
    />
  );
}