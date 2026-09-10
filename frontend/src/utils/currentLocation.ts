import * as Location from "expo-location";

export type ResolvedLocation = {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
};

export type LocationResult = {
  ok: boolean;
  /** ok=false 일 때만: 권한 거부 / 위치 못 잡음 */
  reason?: "permission" | "no-fix";
  /** ok=true 일 때만 채워짐 */
  location?: ResolvedLocation;
};

/**
 * 현재 GPS 위치를 좌표 + (가능하면) 역지오코딩된 이름/주소로 해석한다.
 *
 * - 권한 거부: { ok:false, reason:"permission" }
 * - 콜드 GPS(에뮬레이터/실내)로 현재 위치가 안 잡히면 getLastKnownPositionAsync 폴백.
 *   그래도 없으면 { ok:false, reason:"no-fix" }
 * - 역지오코딩은 실패해도 좌표만으로 진행("내 위치").
 *
 * search.tsx 의 '내 위치' 버튼과 route-select.tsx 의 현위치 버튼이 공유한다 —
 * 두 군데서 따로 구현해 폴백/타임아웃 로직이 갈라지지 않게.
 */
export async function resolveCurrentLocation(): Promise<LocationResult> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return { ok: false, reason: "permission" };

  let loc: any;
  try {
    loc = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
  } catch {
    loc = await Location.getLastKnownPositionAsync({});
  }
  if (!loc?.coords) return { ok: false, reason: "no-fix" };

  const { latitude, longitude } = loc.coords;

  let name = "내 위치";
  let address = "현재 위치";
  try {
    const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (geo) {
      const full = [geo.region, geo.city, geo.district, geo.street, geo.name]
        .filter(Boolean)
        .join(" ");
      if (full) address = full;
      name = geo.name || geo.street || geo.district || "내 위치";
    }
  } catch {}

  return { ok: true, location: { latitude, longitude, name, address } };
}

/** null 을 반환하는 단순 버전 (사유 구분이 필요 없을 때). */
export async function tryResolveCurrentLocation(): Promise<ResolvedLocation | null> {
  const r = await resolveCurrentLocation();
  return r.ok && r.location ? r.location : null;
}
