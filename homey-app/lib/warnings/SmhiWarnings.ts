import { httpsRequest } from '../http.js';

const WARNINGS_URL = 'https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json';

export type WarningLevel = 'MESSAGE' | 'YELLOW' | 'ORANGE' | 'RED';
const LEVEL_RANK: Record<WarningLevel, number> = { MESSAGE: 0, YELLOW: 1, ORANGE: 2, RED: 3 };

export interface WeatherWarning {
  id: string; // warning area id, stable across updates
  level: WarningLevel;
  eventCode: string;
  category: string; // SMHI classification: MET (weather), HYD (hydrology), ...
  title: string; // localised event description
  areaName: string;
  start: Date | null;
  end: Date | null;
}

export interface WarningFilter {
  minLevel: WarningLevel;
  weatherOnly: boolean; // only meteorological warnings (wind, snow, thunder, ...)
  leadHours: number; // include warnings starting within this many hours
}

type Position = [number, number]; // [lon, lat]
type Geometry =
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

interface RawWarning {
  event: { code: string; sv?: string; en?: string; mhoClassification?: { code: string } };
  warningAreas: Array<{
    id: number;
    approximateStart?: string;
    approximateEnd?: string;
    areaName?: { sv?: string; en?: string };
    warningLevel: { code: WarningLevel };
    eventDescription?: { sv?: string; en?: string };
    area?: { geometry?: Geometry };
  }>;
}

/** Even-odd ray casting over the rings of a polygon (outer ring + holes). */
function inRings(lon: number, lat: number, rings: Position[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function containsPoint(geometry: Geometry | undefined, lat: number, lon: number): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return inRings(lon, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => inRings(lon, lat, polygon));
  return false;
}

export function parseWarnings(
  raw: RawWarning[],
  lat: number,
  lon: number,
  now: Date,
  filter: WarningFilter,
  language: 'sv' | 'en' = 'en',
): WeatherWarning[] {
  const horizon = now.getTime() + filter.leadHours * 3_600_000;
  const result: WeatherWarning[] = [];
  for (const warning of raw) {
    const category = warning.event.mhoClassification?.code ?? '';
    if (filter.weatherOnly && category !== 'MET') continue;
    for (const area of warning.warningAreas) {
      const level = area.warningLevel.code;
      if ((LEVEL_RANK[level] ?? -1) < LEVEL_RANK[filter.minLevel]) continue;
      const start = area.approximateStart ? new Date(area.approximateStart) : null;
      const end = area.approximateEnd ? new Date(area.approximateEnd) : null;
      if (end && end <= now) continue;
      if (start && start.getTime() > horizon) continue;
      if (!containsPoint(area.area?.geometry, lat, lon)) continue;
      result.push({
        id: String(area.id),
        level,
        eventCode: warning.event.code,
        category,
        title: area.eventDescription?.[language] ?? area.eventDescription?.sv ?? warning.event[language] ?? warning.event.code,
        areaName: area.areaName?.[language] ?? area.areaName?.sv ?? '',
        start,
        end,
      });
    }
  }
  return result.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
}

export async function fetchWarnings(
  lat: number,
  lon: number,
  now: Date,
  filter: WarningFilter,
  language: 'sv' | 'en' = 'en',
): Promise<WeatherWarning[]> {
  const response = await httpsRequest(WARNINGS_URL, { timeoutMs: 20_000 });
  if (response.status !== 200) throw new Error(`SMHI HTTP ${response.status}`);
  return parseWarnings(JSON.parse(response.body) as RawWarning[], lat, lon, now, filter, language);
}
