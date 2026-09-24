import { httpsRequest } from '../http.js';
import { containsPoint, type WarningFilter, type WarningLevel, type WeatherWarning } from './SmhiWarnings.js';

/** MET Norway asks every client to identify itself. */
const USER_AGENT = 'SolisSmartBattery/0.1 github.com/Lorkster/solis-integration';
const LEVEL_RANK: Record<WarningLevel, number> = { MESSAGE: 0, YELLOW: 1, ORANGE: 2, RED: 3 };

/** MET awareness types that are not weather as such (floods, landslides, avalanches, forest fire). */
const NOT_WEATHER = new Set(['8', '9', '11', '12', '13']);

interface MetFeature {
  properties: {
    id: string;
    area?: string;
    awareness_level?: string; // "2; yellow; Moderate"
    awareness_type?: string; // "1; Wind"
    eventAwarenessName?: string;
    event?: string;
    geographicDomain?: string; // "land" | "marine"
    title?: string;
  };
  when?: { interval?: [string, string] };
  geometry?: Parameters<typeof containsPoint>[0];
}

function level(awareness: string | undefined): WarningLevel | null {
  const colour = awareness?.split(';')[1]?.trim().toLowerCase();
  if (colour === 'yellow') return 'YELLOW';
  if (colour === 'orange') return 'ORANGE';
  if (colour === 'red') return 'RED';
  return null;
}

export function parseMetNoWarnings(json: unknown, lat: number, lon: number, now: Date, filter: WarningFilter): WeatherWarning[] {
  const horizon = now.getTime() + filter.leadHours * 3_600_000;
  const result: WeatherWarning[] = [];
  for (const f of (json as { features?: MetFeature[] }).features ?? []) {
    const p = f.properties;
    if (p.geographicDomain && p.geographicDomain !== 'land') continue;
    const lvl = level(p.awareness_level);
    if (!lvl || LEVEL_RANK[lvl] < LEVEL_RANK[filter.minLevel]) continue;
    const type = p.awareness_type?.split(';')[0]?.trim() ?? '';
    if (filter.weatherOnly && NOT_WEATHER.has(type)) continue;
    const [startIso, endIso] = f.when?.interval ?? [];
    const start = startIso ? new Date(startIso) : null;
    const end = endIso ? new Date(endIso) : null;
    if (end && end <= now) continue;
    if (start && start.getTime() > horizon) continue;
    if (f.geometry && !containsPoint(f.geometry, lat, lon)) continue;
    result.push({
      id: p.id,
      level: lvl,
      eventCode: p.event ?? '',
      category: type,
      title: p.eventAwarenessName ?? p.event ?? p.title ?? '',
      areaName: p.area ?? '',
      start,
      end,
    });
  }
  return result.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
}

/** Current MET Norway warnings (MetAlerts 2.0) for a point in Norway. */
export async function fetchMetNoWarnings(
  lat: number,
  lon: number,
  now: Date,
  filter: WarningFilter,
  language: 'sv' | 'en' = 'en',
): Promise<WeatherWarning[]> {
  const url = `https://api.met.no/weatherapi/metalerts/2.0/current.json?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`
    + `&lang=${language === 'sv' ? 'no' : 'en'}`;
  const response = await httpsRequest(url, { timeoutMs: 20_000, headers: { 'User-Agent': USER_AGENT } });
  if (response.status !== 200) throw new Error(`MET Norway HTTP ${response.status}`);
  return parseMetNoWarnings(JSON.parse(response.body), lat, lon, now, filter);
}
