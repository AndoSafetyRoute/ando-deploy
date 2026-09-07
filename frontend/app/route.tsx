import React from "react";
import { router, useLocalSearchParams } from "expo-router";
import RouteScreen from "../src/screens/route/RouteScreen";

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function RoutePage() {
  const params = useLocalSearchParams();

  // navigation.tsx에서 특정 필드만 골라 넘기다가 transitNextLeg 등이 조용히
  // 유실되는 버그가 있었다 — 같은 패턴이라 여기도 전부 넘기고 필요한 것만 덧씌운다.
  const forwardedParams: Record<string, string> = {};
  Object.entries(params).forEach(([key, value]) => {
    forwardedParams[key] = getParam(value);
  });

  const from = getParam(params.from || params.startName, "출발지");
  const to = getParam(params.to || params.endName, "도착지");
  const routeData = getParam(params.routeData, "");

  const startName = getParam(params.startName);
  const startAddress = getParam(params.startAddress);
  const startLatitude = getParam(params.startLatitude);
  const startLongitude = getParam(params.startLongitude);

  const endName = getParam(params.endName);
  const endAddress = getParam(params.endAddress);
  const endLatitude = getParam(params.endLatitude);
  const endLongitude = getParam(params.endLongitude);

  const navigationAdapter = {
    goBack: () => router.back(),

    navigate: (screenName: string, screenParams?: Record<string, any>) => {
      if (screenName === "Navigation") {
        // push를 쓰면 search→place-info→route-select→route가 스택에 그대로
        // 남아있어서, 안내를 마치고 뒤로가기를 홈까지 4~5번 눌러야 하는 문제가
        // 있었다(route-compare.tsx의 같은 어댑터는 이미 replace를 쓰고 있음 —
        // 도보/대중교통/자동차 단일경로 흐름만 여기 남아있던 불일치).
        router.replace({
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

      // ⑬ 3경로 비교 화면. ROUTE_COMPARE_ENABLED=true 면 WalkContent의 "안내 시작"이
      // goToRouteCompareIfEnabled → navigate("RouteCompare") 를 태우는데, 여기에
      // 케이스가 없어서 아래 router.replace("/") 로 떨어져 홈으로 튕겨나갔다.
      // push 로 열어야 비교 화면에서 뒤로가기가 경로 화면으로 돌아온다.
      if (screenName === "RouteCompare") {
        router.push({
          pathname: "/route-compare",
          params: screenParams,
        });
        return;
      }

      router.replace("/");
    },
  };

  return (
    <RouteScreen
      navigation={navigationAdapter}
      route={{
        params: {
          ...forwardedParams,
          from,
          to,
          routeData,

          startName,
          startAddress,
          startLatitude,
          startLongitude,

          endName,
          endAddress,
          endLatitude,
          endLongitude,
        },
      }}
    />
  );
}