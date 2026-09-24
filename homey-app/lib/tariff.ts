import { localParts } from './time.js';

/**
 * Converts a spot price into what the household actually pays or receives.
 *
 * Swedish setup (Vattenfall example): supplier adders, energy tax and grid transfer fee are
 * charged per kWh excluding VAT, then VAT is applied to the sum. Export pays spot plus a
 * grid-benefit compensation ("nätnytta"), without VAT.
 */
export interface TariffConfig {
  vatFactor: number; // 1.25
  supplierFeeSekPerKwh: number; // variable supplier costs + markups, ex VAT
  energyTaxSekPerKwh: number; // ex VAT
  gridFeeSekPerKwh: number; // transfer fee outside high-load time, ex VAT
  gridFeeHighLoadSekPerKwh: number; // transfer fee during high-load time, ex VAT
  highLoadEnabled: boolean;
  highLoad?: HighLoadWindow;
  exportBonusSekPerKwh: number; // grid benefit paid on export
}

/** When the higher grid fee applies. Defaults: Vattenfall Eldistribution's time tariff. */
export interface HighLoadWindow {
  fromHour: number;
  toHour: number; // exclusive
  weekdaysOnly: boolean;
  winterOnly: boolean; // November–March
  holidaysExcluded: boolean; // public holidays on weekdays count as other time
}

export const VATTENFALL_HIGH_LOAD: HighLoadWindow = {
  fromHour: 6,
  toHour: 22,
  weekdaysOnly: true,
  winterOnly: true,
  holidaysExcluded: true,
};

export const DEFAULT_TARIFF: TariffConfig = {
  vatFactor: 1.25,
  supplierFeeSekPerKwh: 0.1223,
  energyTaxSekPerKwh: 0.36,
  // Vattenfall Eldistribution Tidstariff 2026: 30.5 / 76.5 öre/kWh incl. VAT.
  gridFeeSekPerKwh: 0.244,
  gridFeeHighLoadSekPerKwh: 0.612,
  highLoadEnabled: true,
  highLoad: VATTENFALL_HIGH_LOAD,
  exportBonusSekPerKwh: 0.104,
};

/** Easter Sunday (Gregorian), as [month 1–12, day]. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/**
 * Days that count as holidays for Swedish time tariffs even on weekdays (Vattenfall's list from
 * 2026): New Year's Day, Epiphany, Good Friday, Easter Monday, Christmas Eve, Christmas Day,
 * Boxing Day and New Year's Eve. Returned as "M-D".
 */
export function tariffHolidays(year: number): Set<string> {
  const [month, day] = easter(year);
  const sunday = Date.UTC(year, month - 1, day);
  const shifted = (days: number) => {
    const d = new Date(sunday + days * 86_400_000);
    return `${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  };
  return new Set(['1-1', '1-6', shifted(-2), shifted(1), '12-24', '12-25', '12-26', '12-31']);
}

export function isHighLoadTime(date: Date, timeZone: string, window: HighLoadWindow = VATTENFALL_HIGH_LOAD): boolean {
  const { year, month, day, weekday, hour } = localParts(date, timeZone);
  if (window.winterOnly && !(month >= 11 || month <= 3)) return false;
  if (window.weekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  if (window.holidaysExcluded && tariffHolidays(year).has(`${month}-${day}`)) return false;
  return window.fromHour <= window.toHour
    ? hour >= window.fromHour && hour < window.toHour
    : hour >= window.fromHour || hour < window.toHour;
}

export function buyPrice(spotSekPerKwh: number, date: Date, timeZone: string, cfg: TariffConfig): number {
  const gridFee = cfg.highLoadEnabled && isHighLoadTime(date, timeZone, cfg.highLoad)
    ? cfg.gridFeeHighLoadSekPerKwh
    : cfg.gridFeeSekPerKwh;
  return cfg.vatFactor * (spotSekPerKwh + cfg.supplierFeeSekPerKwh + cfg.energyTaxSekPerKwh + gridFee);
}

export function sellPrice(spotSekPerKwh: number, cfg: TariffConfig): number {
  return spotSekPerKwh + cfg.exportBonusSekPerKwh;
}
