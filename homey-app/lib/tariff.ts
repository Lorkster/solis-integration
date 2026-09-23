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
  exportBonusSekPerKwh: number; // grid benefit paid on export
}

export const DEFAULT_TARIFF: TariffConfig = {
  vatFactor: 1.25,
  supplierFeeSekPerKwh: 0.1223,
  energyTaxSekPerKwh: 0.36,
  gridFeeSekPerKwh: 0.244,
  // TODO: fill in Vattenfall Tidstariff T4 high-load price from the current price list.
  gridFeeHighLoadSekPerKwh: 0.244,
  highLoadEnabled: true,
  exportBonusSekPerKwh: 0.104,
};

/**
 * Vattenfall Eldistribution time tariff high-load time: November–March, weekdays 06–22.
 * Public holidays are not excluded (conservative: slightly overestimates the price).
 */
export function isHighLoadTime(date: Date, timeZone: string): boolean {
  const { month, weekday, hour } = localParts(date, timeZone);
  const winter = month >= 11 || month <= 3;
  const weekday_ = weekday >= 1 && weekday <= 5;
  return winter && weekday_ && hour >= 6 && hour < 22;
}

export function buyPrice(spotSekPerKwh: number, date: Date, timeZone: string, cfg: TariffConfig): number {
  const gridFee = cfg.highLoadEnabled && isHighLoadTime(date, timeZone)
    ? cfg.gridFeeHighLoadSekPerKwh
    : cfg.gridFeeSekPerKwh;
  return cfg.vatFactor * (spotSekPerKwh + cfg.supplierFeeSekPerKwh + cfg.energyTaxSekPerKwh + gridFee);
}

export function sellPrice(spotSekPerKwh: number, cfg: TariffConfig): number {
  return spotSekPerKwh + cfg.exportBonusSekPerKwh;
}
