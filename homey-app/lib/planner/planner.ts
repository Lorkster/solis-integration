/**
 * Battery plan optimiser.
 *
 * Chooses one action per price interval (normally 15 minutes) so that the total electricity
 * cost over the horizon is minimal, using dynamic programming over the battery energy level.
 *
 *  - self_use: the inverter's normal behaviour. The battery covers house load (down to the
 *              reserve) and stores PV surplus.
 *  - charge:   charge from grid (plus PV) at the configured power.
 *  - hold:     keep the stored energy; the house runs on grid/PV.
 *
 * The battery never discharges to the grid (self-use only), which matches the tariff: export
 * pays roughly spot while import costs spot + fees + VAT.
 *
 * With a power-based grid fee, import above the month's peak level costs extra, and grid charging
 * is limited to the headroom below that level: per kW such fees cost far more than any price
 * difference between hours can earn.
 */

export type BatteryAction = 'self_use' | 'charge' | 'hold';
export const ACTIONS: readonly BatteryAction[] = ['self_use', 'hold', 'charge']; // tie-break order

export interface PlanInterval {
  start: Date;
  end: Date;
  buy: number; // SEK/kWh paid for import
  sell: number; // SEK/kWh received for export
  loadKw: number; // expected average house load
  pvKw: number; // expected average PV production
  /** How much import in this interval counts towards a power-based grid fee (0–1). */
  peakWeight?: number;
}

/** Power-based grid fee as seen by the planner. */
export interface PeakCost {
  /** Cost per kW that a fee period's average import ends above the threshold. */
  costPerKw: number;
  /** Weighted import level (kW) above which the month's fee rises. */
  thresholdKw: number;
  /** Length of a fee period (1 = hourly peaks, 0.25 = quarter-hour peaks). */
  periodHours: number;
}

export interface PlanInput {
  intervals: PlanInterval[];
  socPct: number;
  capacityKwh: number;
  reserveSocPct: number; // self-use never discharges below this; energy below it is backup
  maxSocPct: number;
  maxChargeKw: number; // AC power drawn when charging from grid
  maxDischargeKw: number;
  roundTripEfficiency: number;
  cyclingCostPerKwh: number; // wear cost per kWh discharged from the battery
  minGainPerKwh: number; // extra margin required before grid charging is worth it
  /** Force a specific action in interval i (manual overrides from flows). */
  fixedActions?: Map<number, BatteryAction>;
  /** Penalty per kWh·h spent below the reserve; pushes the plan to restore the reserve fast. */
  reservePenaltyPerKwhHour?: number;
  /** Value per kWh left above the reserve at the end. Defaults to a horizon-average estimate. */
  terminalValuePerKwh?: number;
  /**
   * Cost of changing action between intervals. Keeps the plan from chasing tiny 15-minute price
   * differences, which would fragment it into more blocks than the inverter has slots.
   */
  switchPenaltySek?: number;
  /** Action in effect before the first interval (for the switch penalty). */
  initialAction?: BatteryAction;
  /** Power-based grid fee; omitted when the grid company has none. */
  peak?: PeakCost;
}

export interface PlannedInterval {
  start: Date;
  end: Date;
  buy: number;
  sell: number;
  action: BatteryAction;
  socStartPct: number;
  socEndPct: number;
  gridKwh: number; // positive = import
  batteryKwh: number; // stored energy change, positive = charging
  /** Grid charging power (kW, AC side) for charge intervals, 0 otherwise. */
  chargeKw: number;
  /**
   * What one more kWh taken out of the battery at the start of this interval costs later, in SEK
   * (the slope of the optimal cost-to-go). High before an expensive peak, low when the battery
   * will be refilled cheaply or by solar anyway.
   */
  storedEnergyValue: number;
}

export interface PlanResult {
  intervals: PlannedInterval[];
  costSek: number; // including terminal value
  baselineCostSek: number; // same horizon with plain self-use
  savingsSek: number;
  terminalValuePerKwh: number;
}

const ENERGY_STEP_KWH = 0.05;
const EPSILON = 1e-9;

interface Step {
  delta: number; // stored energy change, kWh
  gridKwh: number;
  cost: number;
  chargeKw: number;
}

export function planBattery(input: PlanInput): PlanResult {
  const n = input.intervals.length;
  if (n === 0) {
    return { intervals: [], costSek: 0, baselineCostSek: 0, savingsSek: 0, terminalValuePerKwh: 0 };
  }

  const eff = Math.sqrt(input.roundTripEfficiency); // one-way efficiency
  const maxE = input.capacityKwh * input.maxSocPct / 100;
  const reserveE = input.capacityKwh * input.reserveSocPct / 100;
  const states = Math.floor(maxE / ENERGY_STEP_KWH) + 1;
  const penalty = input.reservePenaltyPerKwhHour ?? 20;
  const terminalValue = input.terminalValuePerKwh ?? defaultTerminalValue(input, eff);

  const peak = input.peak && input.peak.costPerKw > 0 && input.peak.thresholdKw > 0 ? input.peak : null;
  const toIndex = (e: number) => Math.min(states - 1, Math.max(0, Math.round(e / ENERGY_STEP_KWH)));
  const toEnergy = (i: number) => i * ENERGY_STEP_KWH;

  const step = (t: number, e: number, action: BatteryAction): Step => {
    const iv = input.intervals[t];
    const hours = (iv.end.getTime() - iv.start.getTime()) / 3_600_000;
    const netKwh = (iv.loadKw - iv.pvKw) * hours; // positive = house needs energy
    const weight = peak ? iv.peakWeight ?? 0 : 0;
    let delta = 0;
    let chargeKw = 0;

    if (action === 'self_use') {
      if (netKwh >= 0) {
        const available = Math.max(0, e - reserveE);
        const out = Math.min(netKwh / eff, available, input.maxDischargeKw * hours / eff);
        delta = -out;
      } else {
        delta = Math.min(-netKwh * eff, maxE - e, input.maxChargeKw * hours * eff);
      }
    } else if (action === 'charge') {
      // With a power fee, charge only in the headroom below the peak level.
      const headroomKw = weight > 0 ? Math.max(0, peak!.thresholdKw / weight - netKwh / hours) : Infinity;
      chargeKw = Math.min(input.maxChargeKw, headroomKw);
      delta = Math.max(0, Math.min(chargeKw * hours * eff, maxE - e));
    }

    const gridKwh = netKwh + (delta > 0 ? delta / eff : delta * eff);
    let cost = gridKwh >= 0 ? gridKwh * iv.buy : gridKwh * iv.sell;
    if (weight > 0) {
      const aboveKw = weight * gridKwh / hours - peak!.thresholdKw;
      if (aboveKw > 0) cost += peak!.costPerKw * aboveKw * hours / peak!.periodHours;
    }
    if (delta < 0) cost += -delta * input.cyclingCostPerKwh;
    if (action === 'charge' && delta > 0) cost += delta * input.minGainPerKwh;
    const deficit = reserveE - (e + delta);
    if (deficit > 0) cost += deficit * hours * penalty;
    return { delta, gridKwh, cost, chargeKw };
  };

  // Backward pass over (energy level, previous action).
  // next[p][i] = minimal cost-to-go from energy index i when the previous interval's action was p.
  const switchPenalty = input.switchPenaltySek ?? 0.5;
  const A = ACTIONS.length;
  const terminal = new Float64Array(states);
  for (let i = 0; i < states; i++) terminal[i] = -terminalValue * Math.max(0, toEnergy(i) - reserveE);
  let next: Float64Array[] = ACTIONS.map(() => terminal);
  const valueAt: Float64Array[] = new Array(n); // best cost-to-go per energy index at the start of t
  const policy: Uint8Array[][] = new Array(n); // policy[t][prev][i] = action index

  const costWithAction = new Float64Array(A);
  for (let t = n - 1; t >= 0; t--) {
    const current = ACTIONS.map(() => new Float64Array(states));
    const choice = ACTIONS.map(() => new Uint8Array(states));
    const fixed = input.fixedActions?.get(t);
    for (let i = 0; i < states; i++) {
      const e = toEnergy(i);
      for (let a = 0; a < A; a++) {
        if (fixed && ACTIONS[a] !== fixed) {
          costWithAction[a] = Infinity;
          continue;
        }
        const s = step(t, e, ACTIONS[a]);
        costWithAction[a] = s.cost + next[a][toIndex(e + s.delta)];
      }
      for (let p = 0; p < A; p++) {
        let best = Infinity;
        let bestAction = 0;
        for (let a = 0; a < A; a++) {
          const total = costWithAction[a] + (a === p ? 0 : switchPenalty);
          if (total < best - EPSILON) {
            best = total;
            bestAction = a;
          }
        }
        current[p][i] = best;
        choice[p][i] = bestAction;
      }
    }
    policy[t] = choice;
    const best = new Float64Array(states);
    for (let i = 0; i < states; i++) best[i] = Math.min(...current.map((c) => c[i]));
    valueAt[t] = best;
    next = current;
  }

  const startE = Math.min(maxE, input.capacityKwh * input.socPct / 100);
  let previous = ACTIONS.indexOf(input.initialAction ?? 'self_use');
  const optimal = simulate(input, startE, (t, e) => {
    previous = policy[t][previous][toIndex(e)];
    return ACTIONS[previous];
  }, step);
  const baseline = simulate(input, startE, (t) => input.fixedActions?.get(t) ?? 'self_use', step);
  const endValue = (e: number) => -terminalValue * Math.max(0, e - reserveE);
  const costSek = optimal.cost + endValue(optimal.endE);
  const baselineCostSek = baseline.cost + endValue(baseline.endE);

  return {
    intervals: optimal.intervals.map((iv, t) => ({
      ...iv,
      storedEnergyValue: marginalValue(valueAt[t], iv.socStartPct / 100 * input.capacityKwh, reserveE),
    })),
    costSek,
    baselineCostSek,
    savingsSek: baselineCostSek - costSek,
    terminalValuePerKwh: terminalValue,
  };
}

/**
 * Cost of removing one kWh from the battery: the slope of the cost-to-go around the current energy
 * level, taken over ±0.5 kWh to smooth the discretisation. Energy at or below the reserve is not
 * available for normal use, so its value is not meaningful and the slope above it is used.
 */
function marginalValue(values: Float64Array, energyKwh: number, reserveKwh: number): number {
  const span = Math.round(0.5 / ENERGY_STEP_KWH);
  const last = values.length - 1;
  const here = Math.min(last, Math.max(0, Math.round(Math.max(energyKwh, reserveKwh) / ENERGY_STEP_KWH)));
  const lo = Math.max(0, here - span);
  const hi = Math.min(last, here + span);
  if (hi === lo) return 0;
  return Math.max(0, (values[lo] - values[hi]) / ((hi - lo) * ENERGY_STEP_KWH));
}

function simulate(
  input: PlanInput,
  startE: number,
  decide: (t: number, e: number) => BatteryAction,
  step: (t: number, e: number, action: BatteryAction) => Step,
): { intervals: PlannedInterval[]; cost: number; endE: number } {
  const intervals: PlannedInterval[] = [];
  let e = startE;
  let cost = 0;
  input.intervals.forEach((iv, t) => {
    const action = decide(t, e);
    const s = step(t, e, action);
    const endE = e + s.delta;
    intervals.push({
      start: iv.start,
      end: iv.end,
      buy: iv.buy,
      sell: iv.sell,
      action,
      socStartPct: e / input.capacityKwh * 100,
      socEndPct: endE / input.capacityKwh * 100,
      gridKwh: s.gridKwh,
      batteryKwh: s.delta,
      chargeKw: s.chargeKw,
      storedEnergyValue: 0, // filled in by planBattery
    });
    cost += s.cost;
    e = endE;
  });
  return { intervals, cost, endE: e };
}

/**
 * Energy left in the battery at the end of the horizon will displace future purchases. Value it
 * at the average import price of the horizon, net of discharge losses and wear. Conservative
 * enough that the plan does not charge just to end full.
 */
function defaultTerminalValue(input: PlanInput, eff: number): number {
  const avg = input.intervals.reduce((sum, iv) => sum + iv.buy, 0) / input.intervals.length;
  return Math.max(0, avg * eff - input.cyclingCostPerKwh);
}
