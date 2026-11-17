// Illustrative globe placement. These are NOT measured server locations: root and many TLD/authoritative
// servers are anycast (one IP, hundreds of sites), and an IP address does not reveal physical location.
import type { DnsEvent, NodeId } from "@/shared/dns";

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

const P = (name: string, lat: number, lon: number): Place => ({ name, lat, lon });

export const CLIENT_PRESETS = [
  { id: "london", client: P("London", 51.51, -0.13), resolver: P("Amsterdam (resolver PoP)", 52.37, 4.9) },
  { id: "newyork", client: P("New York", 40.71, -74.0), resolver: P("Ashburn, VA (resolver PoP)", 39.04, -77.49) },
  { id: "sf", client: P("San Francisco", 37.77, -122.42), resolver: P("Los Angeles (resolver PoP)", 34.05, -118.24) },
  { id: "saopaulo", client: P("São Paulo", -23.55, -46.63), resolver: P("Rio de Janeiro (resolver PoP)", -22.91, -43.17) },
  { id: "mumbai", client: P("Mumbai", 19.08, 72.88), resolver: P("Chennai (resolver PoP)", 13.08, 80.27) },
  { id: "singapore", client: P("Singapore", 1.35, 103.82), resolver: P("Kuala Lumpur (resolver PoP)", 3.14, 101.69) },
  { id: "tokyo", client: P("Tokyo", 35.68, 139.69), resolver: P("Osaka (resolver PoP)", 34.69, 135.5) },
  { id: "sydney", client: P("Sydney", -33.87, 151.21), resolver: P("Melbourne (resolver PoP)", -37.81, 144.96) },
] as const;
export type ClientPresetId = (typeof CLIENT_PRESETS)[number]["id"];

const ROOT_SITES = [
  P("Amsterdam", 52.37, 4.9), P("Ashburn", 39.04, -77.49), P("Los Angeles", 34.05, -118.24), P("Tokyo", 35.68, 139.69),
  P("Singapore", 1.29, 103.85), P("São Paulo", -23.55, -46.63), P("Sydney", -33.87, 151.21), P("Frankfurt", 50.11, 8.68),
  P("Johannesburg", -26.2, 28.05), P("Mumbai", 19.08, 72.88),
];

const TLD_SITES: Record<string, Place> = {
  com: P("Reston, VA", 38.96, -77.36), net: P("Reston, VA", 38.96, -77.36), org: P("Reston, VA", 38.96, -77.36),
  io: P("London", 51.51, -0.13), uk: P("London", 51.51, -0.13), de: P("Frankfurt", 50.11, 8.68), fr: P("Paris", 48.86, 2.35),
  nl: P("Arnhem", 51.98, 5.91), in: P("Mumbai", 19.08, 72.88), jp: P("Tokyo", 35.68, 139.69), au: P("Melbourne", -37.81, 144.96),
  br: P("São Paulo", -23.55, -46.63), ca: P("Ottawa", 45.42, -75.7), cn: P("Beijing", 39.9, 116.4),
};

const DATACENTERS = [
  P("Ashburn, VA", 39.04, -77.49), P("Dallas", 32.78, -96.8), P("Oregon", 45.6, -121.18), P("Dublin", 53.35, -6.26),
  P("Frankfurt", 50.11, 8.68), P("Singapore", 1.29, 103.85), P("Tokyo", 35.68, 139.69), P("São Paulo", -23.55, -46.63),
  P("Sydney", -33.87, 151.21), P("Mumbai", 19.08, 72.88), P("Stockholm", 59.33, 18.07),
];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function distKm(a: Place, b: Place) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Nearest anycast-style site that is far enough away to draw a visible arc. */
const nearest = (from: Place, sites: Place[]) =>
  sites.filter((s) => distKm(from, s) > 250).sort((a, b) => distKm(from, a) - distKm(from, b))[0] ?? sites[0];

/** Places for every node, refined as referral events reveal the real TLD / authoritative zone. */
export function placeNodes(presetId: ClientPresetId, domain: string, events: DnsEvent[]): Record<NodeId, Place> {
  const preset = CLIENT_PRESETS.find((p) => p.id === presetId) ?? CLIENT_PRESETS[0];
  const labels = domain.split(".");
  const tldZone = events.findLast((e) => e.type === "ROOT_REFERRAL")?.data?.zone ?? labels[labels.length - 1] ?? "com";
  const authZone =
    events.findLast((e) => e.type === "TLD_REFERRAL" || e.type === "AUTHORITATIVE_REFERRAL")?.data?.zone ?? labels.slice(-2).join(".");
  const tld = tldZone.split(".").pop()!;
  return {
    client: preset.client,
    resolver: preset.resolver,
    cache: preset.resolver,
    root: nearest(preset.resolver, ROOT_SITES),
    tld: TLD_SITES[tld] ?? DATACENTERS[hash(tld) % DATACENTERS.length],
    auth: DATACENTERS[hash(authZone) % DATACENTERS.length],
  };
}
