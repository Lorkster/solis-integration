import type { PriceArea, PriceSource } from './PriceProvider.js';

/** Country from Homey's time zone, for the countries with a supported price area. */
const ZONE_COUNTRY: Record<string, string> = {
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI',
  'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT', 'Europe/Berlin': 'GER',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Paris': 'FR', 'Europe/Vienna': 'AT', 'Europe/Warsaw': 'PL',
};

/**
 * A first guess of the day-ahead price area from Homey's time zone and location. The Swedish,
 * Norwegian and Danish borders are approximated by latitude and longitude, so the guess is shown
 * in the settings for the user to check.
 */
export function suggestPriceArea(timeZone: string, lat: number, lon: number): { area: PriceArea; source: PriceSource } | null {
  const country = ZONE_COUNTRY[timeZone];
  if (!country) return null;
  const known = Number.isFinite(lat) && Number.isFinite(lon);
  if (country === 'SE') {
    let area = 'SE3';
    if (known && lat >= 65.1) area = 'SE1';
    else if (known && lat >= 61.1) area = 'SE2';
    else if (known && lat < 57.0) area = 'SE4';
    return { area, source: 'elprisetjustnu' };
  }
  if (country === 'NO') {
    let area = 'NO1';
    if (known && lat >= 65) area = 'NO4';
    else if (known && lat >= 62) area = 'NO3';
    else if (known && lat >= 59.8 && lon < 7.5) area = 'NO5';
    else if (known && lat < 59.8 && lon < 9) area = 'NO2';
    return { area, source: 'nordpool' };
  }
  if (country === 'DK') return { area: known && lon >= 10.95 ? 'DK2' : 'DK1', source: 'nordpool' };
  return { area: country, source: 'nordpool' };
}
