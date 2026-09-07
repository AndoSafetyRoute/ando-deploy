import React from "react";
import { router, useLocalSearchParams } from "expo-router";
import SlowSegmentFeedbackScreen from "../src/screens/route/SlowSegmentFeedbackScreen";

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function SlowSegmentFeedbackPage() {
  const params = useLocalSearchParams();
  const forwarded: Record<string, string> = {};
  Object.entries(params).forEach(([k, v]) => { forwarded[k] = getParam(v); });

  const navigationAdapter = {
    goBack: () => router.back(),
    navigate: (screenName: string, screenParams?: Record<string, any>) => {
      if (screenName === "RouteDetail") {
        router.replace({ pathname: "/route-detail", params: screenParams });
        return;
      }
      router.replace("/");
    },
    replace: (path: string) => router.replace(path as any),
  };

  return (
    <SlowSegmentFeedbackScreen navigation={navigationAdapter} route={{ params: forwarded }} />
  );
}
