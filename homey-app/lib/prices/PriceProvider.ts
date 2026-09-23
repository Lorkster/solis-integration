import { httpsRequest } from '../http.js';

export type PriceArea = 'SE1' | 'SE2' | 'SE3' | 'SE4';

export interface SpotPrice {
  start: Date;
  end: Date;
  sekPerKwh: number; // spot price excluding VAT and fees
}

export interface PriceProvider {
  /** Spot prices for a local calendar day ("YYYY-MM-DD"), or null if not yet published. */
  getDay(date: string, area: PriceArea): Promise<SpotPrice[] | null>;
}

/**
 * Nord Pool day-ahead prices via elprisetjustnu.se (free, no key, 15-minute resolution).
 * Tomorrow's prices appear around 13:00 CET; until then the endpoint returns 404.
 */
export class ElprisetJustNuProvider implements PriceProvider {
  private readonly cache = new Map<string, SpotPrice[]>();

  async getDay(date: string, area: PriceArea): Promise<SpotPrice[] | null> {
    const key = `${date}_${area}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const [year, month, day] = date.split('-');
    const url = `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${area}.json`;
    const response = await httpsRequest(url, { timeoutMs: 20_000 });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`Price API HTTP ${response.status} for ${date}`);

    const prices = (JSON.parse(response.body) as Array<{ SEK_per_kWh: number; time_start: string; time_end: string }>)
      .map((p) => ({ start: new Date(p.time_start), end: new Date(p.time_end), sekPerKwh: p.SEK_per_kWh }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    this.cache.set(key, prices);
    if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value as string);
    return prices;
  }
}
