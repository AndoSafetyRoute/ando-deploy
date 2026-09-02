import React from "react";
import { router, useLocalSearchParams } from "expo-router";
import RouteCompareScreen from "../src/screens/route/RouteCompareScreen";

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function RouteComparePage() {
  const params = useLocalSearchParams();

  const forwarded: Record<string, string> = {};
  Object.entries(params).forEach(([k, v]) => { forwarded[k] = getParam(v); });

  const navigationAdapter = {
    goBack: () => router.back(),
    navigate: (screenName: string, screenParams?: Record<string, any>) => {
      if (screenName === "Navigation") {
        router.replace({ pathname: "/navigation", params: screenParams });
        return;
      }
      router.push("/");
    },
    replace: (path: string) => router.replace(path as any),
  };

  return (
    <RouteCompareScreen
      navigation={navigationAdapter}
      route={{ params: forwarded }}
    />
  );
}
