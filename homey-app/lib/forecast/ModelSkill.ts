/**
 * How well each weather model has forecast this installation's solar production, learned from
 * measured quarter-hours. Errors are exponentially decayed, so recent weeks count most and a model
 * that improves (or a season where another model does better) is picked up.
 *
 * Weights are proportional to 1 / (mean absolute error)², shrunk 20 % towards equal weights so one
 * model never takes over completely.
 */
export interface SkillData {
  version: 1;
  models: Record<string, { err: number; n: number }>; // decayed sums of |error| (kW) and of samples
}

/** Short names for the Open-Meteo models, for showing the weights. */
export const MODEL_NAMES: Record<string, string> = {
  metno_seamless: 'Yr',
  icon_seamless: 'ICON',
  ecmwf_ifs025: 'ECMWF',
  gfs_seamless: 'GFS',
  meteofrance_seamless: 'Météo-France',
};

const SHRINK = 0.2;

export class ModelSkill {
  private data: SkillData;

  /**
   * @param decay per daylight quarter-hour: 0.995 halves the weight of a sample after ~140 daylight
   *   quarters (2–3 weeks in autumn)
   * @param minSamples decayed daylight quarters a model needs before it is weighted (~1.5 days)
   */
  constructor(data?: SkillData, private readonly decay = 0.995, private readonly minSamples = 48) {
    this.data = data?.version === 1 ? data : { version: 1, models: {} };
  }

  /**
   * One measured quarter-hour against each model's (calibrated) forecast for it. Night and very
   * low light are skipped: every model is right about darkness.
   */
  add(predictions: Record<string, number>, actualKw: number, kwpTotal: number): void {
    if (!Number.isFinite(actualKw) || actualKw < 0) return;
    const values = Object.values(predictions).filter(Number.isFinite);
    if (values.length === 0 || Math.max(actualKw, ...values) < 0.05 * kwpTotal) return;
    for (const [model, predicted] of Object.entries(predictions)) {
      if (!Number.isFinite(predicted)) continue;
      const entry = (this.data.models[model] ??= { err: 0, n: 0 });
      entry.err = entry.err * this.decay + Math.abs(predicted - actualKw);
      entry.n = entry.n * this.decay + 1;
    }
  }

  /** Mean absolute error (kW) of a model, or null before it has enough samples. */
  mae(model: string): number | null {
    const e = this.data.models[model];
    return e && e.n >= this.minSamples ? e.err / e.n : null;
  }

  /**
   * Weights for the given models (summing to 1), or null while fewer than two models have enough
   * samples – then the caller uses the median instead. Models without enough samples yet get the
   * average weight of the others.
   */
  weights(models: readonly string[], kwpTotal: number): Record<string, number> | null {
    const floor = 0.02 * kwpTotal; // errors below ~2 % of the size are treated alike
    const raw: Record<string, number> = {};
    for (const m of models) {
      const mae = this.mae(m);
      if (mae !== null) raw[m] = 1 / (mae + floor) ** 2;
    }
    const known = Object.values(raw);
    if (known.length < 2) return null;
    const average = known.reduce((a, b) => a + b, 0) / known.length;
    for (const m of models) raw[m] ??= average;
    const total = models.reduce((sum, m) => sum + raw[m], 0);
    return Object.fromEntries(models.map((m) => [m, (1 - SHRINK) * raw[m] / total + SHRINK / models.length]));
  }

  /** "Yr 31 % · ICON 24 % · …", strongest first; null while still learning. */
  describe(models: readonly string[], kwpTotal: number): string | null {
    const w = this.weights(models, kwpTotal);
    if (!w) return null;
    return Object.entries(w)
      .sort((a, b) => b[1] - a[1])
      .map(([m, v]) => `${MODEL_NAMES[m] ?? m} ${Math.round(v * 100)} %`)
      .join(' · ');
  }

  toJSON(): SkillData {
    return this.data;
  }
}
