import { httpsRequest } from '../http.js';
import { localDate } from '../time.js';

export type PriceSource = 'elprisetjustnu' | 'nordpool' | 'flow';

/** Day-ahead bidding zone, e.g. "SE3", "NO1", "FI", "GER" (Nord Pool codes). */
export type PriceArea = string;

export interface SpotPrice {
  start: Date;
  end: Date;
  perKwh: number; // spot price in the area's currency, excluding VAT and fees
}

export interface PriceProvider {
  /** Spot prices for a delivery day ("YYYY-MM-DD"), or null if not yet published. */
  getDay(date: string, area: PriceArea): Promise<SpotPrice[] | null>;
}

const QUARTER_MS = 900_000;

/** Currency Nord Pool quotes each area in. */
export function currencyForArea(area: PriceArea): string {
  if (area.startsWith('SE')) return 'SEK';
  if (area.startsWith('NO')) return 'NOK';
  if (area.startsWith('DK')) return 'DKK';
  if (area === 'PL') return 'PLN';
  return 'EUR';
}

/** Splits longer periods (hourly prices) into quarter-hours, which the planner and widgets use. */
export function toQuarters(prices: SpotPrice[]): SpotPrice[] {
  const out: SpotPrice[] = [];
  for (const p of prices) {
    for (let t = p.start.getTime(); t < p.end.getTime(); t += QUARTER_MS) {
      out.push({ start: new Date(t), end: new Date(Math.min(t + QUARTER_MS, p.end.getTime())), perKwh: p.perKwh });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Small per-day cache: published day-ahead prices do not change. */
abstract class CachedDayProvider implements PriceProvider {
  private readonly cache = new Map<string, SpotPrice[]>();

  async getDay(date: string, area: PriceArea): Promise<SpotPrice[] | null> {
    const key = `${date}_${area}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const prices = await this.fetchDay(date, area);
    if (!prices || prices.length === 0) return null;
    const quarters = toQuarters(prices);
    this.cache.set(key, quarters);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
    return quarters;
  }

  protected abstract fetchDay(date: string, area: PriceArea): Promise<SpotPrice[] | null>;
}

/**
 * Nord Pool day-ahead prices via elprisetjustnu.se (Sweden only, free, no key).
 * Tomorrow's prices appear around 13:00 CET; until then the endpoint returns 404.
 */
export class ElprisetJustNuProvider extends CachedDayProvider {
  protected async fetchDay(date: string, area: PriceArea): Promise<SpotPrice[] | null> {
    if (!/^SE[1-4]$/.test(area)) throw new Error(`elprisetjustnu.se only covers SE1–SE4, not ${area}; choose Nord Pool as the price source`);
    const [year, month, day] = date.split('-');
    const url = `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${area}.json`;
    const response = await httpsRequest(url, { timeoutMs: 20_000 });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Price API HTTP ${response.status} for ${date}`);
    return (JSON.parse(response.body) as Array<{ SEK_per_kWh: number; time_start: string; time_end: string }>)
      .map((p) => ({ start: new Date(p.time_start), end: new Date(p.time_end), perKwh: p.SEK_per_kWh }));
  }
}

/**
 * Nord Pool's own day-ahead data portal (free, no key): the Nordics, the Baltics, Germany, the
 * Netherlands, Belgium, France, Austria and Poland, in the area's currency. Returns 204 until the
 * day is published.
 */
export class NordPoolProvider extends CachedDayProvider {
  protected async fetchDay(date: string, area: PriceArea): Promise<SpotPrice[] | null> {
    const url = 'https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices'
      + `?date=${date}&market=DayAhead&deliveryArea=${encodeURIComponent(area)}&currency=${currencyForArea(area)}`;
    const response = await httpsRequest(url, { timeoutMs: 20_000 });
    if (response.status === 204 || response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Nord Pool HTTP ${response.status} for ${date}`);
    return parseNordPool(JSON.parse(response.body), area);
  }
}

export function parseNordPool(json: unknown, area: PriceArea): SpotPrice[] {
  const entries = (json as { multiAreaEntries?: Array<{ deliveryStart: string; deliveryEnd: string; entryPerArea: Record<string, number> }> })
    .multiAreaEntries ?? [];
  return entries
    .filter((e) => Number.isFinite(e.entryPerArea?.[area]))
    .map((e) => ({ start: new Date(e.deliveryStart), end: new Date(e.deliveryEnd), perKwh: e.entryPerArea[area] / 1000 }));
}

/**
 * Prices pushed from a Homey flow ("Set electricity prices"), so any price service with a Homey
 * app or an API reachable from a flow can drive the plan.
 */
export class FlowPriceProvider implements PriceProvider {
  private prices = new Map<number, SpotPrice>();

  constructor(private readonly timeZone: string, stored: Array<{ start: string; end: string; perKwh: number }> = []) {
    this.merge(stored.map((p) => ({ start: new Date(p.start), end: new Date(p.end), perKwh: p.perKwh })));
  }

  /** Adds or replaces prices; keeps the last three days. Returns the number of quarter-hours added. */
  merge(prices: SpotPrice[]): number {
    const quarters = toQuarters(prices);
    for (const p of quarters) this.prices.set(p.start.getTime(), p);
    const keepFrom = Date.now() - 3 * 86_400_000;
    for (const t of this.prices.keys()) if (t < keepFrom) this.prices.delete(t);
    return quarters.length;
  }

  async getDay(date: string): Promise<SpotPrice[] | null> {
    const day = [...this.prices.values()]
      .filter((p) => localDate(p.start, this.timeZone) === date)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    return day.length > 0 ? day : null;
  }

  toJSON(): Array<{ start: string; end: string; perKwh: number }> {
    return [...this.prices.values()].map((p) => ({ start: p.start.toISOString(), end: p.end.toISOString(), perKwh: p.perKwh }));
  }
}

/**
 * Parses the "Set electricity prices" flow argument: a JSON list of { start, price } entries (also
 * accepts the field names used by common price services). Without an end time, an entry runs until
 * the next entry (at most an hour); the last one lasts as long as the one before it.
 */
export function parseFlowPrices(text: string): SpotPrice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Prices must be JSON, e.g. [{"start":"2026-09-25T00:00:00+02:00","price":0.52}]');
  }
  const list = Array.isArray(raw) ? raw : (raw as { prices?: unknown[] })?.prices;
  if (!Array.isArray(list)) throw new Error('Prices must be a JSON list');

  const pick = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);
  const points = list.map((item) => {
    const o = item as Record<string, unknown>;
    const start = new Date(String(pick(o, ['start', 'startsAt', 'time_start', 'time', 'from'])));
    const endRaw = pick(o, ['end', 'endsAt', 'time_end', 'to']);
    const price = Number(pick(o, ['price', 'total', 'value', 'energy', 'SEK_per_kWh', 'EUR_per_kWh']));
    if (Number.isNaN(start.getTime()) || !Number.isFinite(price)) throw new Error(`Unreadable price entry: ${JSON.stringify(item)}`);
    return { start, end: endRaw ? new Date(String(endRaw)) : null, perKwh: price };
  }).sort((a, b) => a.start.getTime() - b.start.getTime());

  return points.map((p, i) => {
    const next = points[i + 1];
    const previous = points[i - 1];
    const fallbackMs = previous ? p.start.getTime() - previous.start.getTime() : 3_600_000;
    let end: Date;
    if (p.end && !Number.isNaN(p.end.getTime())) end = p.end;
    else if (next) end = new Date(Math.min(next.start.getTime(), p.start.getTime() + 3_600_000));
    else end = new Date(p.start.getTime() + Math.min(fallbackMs, 3_600_000));
    return { start: p.start, end, perKwh: p.perKwh };
  });
}

// Shared between devices so both see the same cached days.
const sharedElpriset = new ElprisetJustNuProvider();
const sharedNordPool = new NordPoolProvider();

export function createPriceProvider(source: PriceSource, flow: FlowPriceProvider): PriceProvider {
  if (source === 'nordpool') return sharedNordPool;
  if (source === 'flow') return flow;
  return sharedElpriset;
}
