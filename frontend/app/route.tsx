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

      router.push("/");
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