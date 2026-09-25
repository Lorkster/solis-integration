// One-off, read-only backtest (not part of the test suite): scores the weather models against the
// measured production of the last 14 days, the way the app does. Needs ../.env and a location file.
import { readFileSync } from 'node:fs';

import { ModelSkill, MODEL_NAMES } from '../lib/forecast/ModelSkill.js';
import { BLEND_MODELS, looksCurtailed, median, modelPvKw, OpenMeteoProvider, SolarCalibration } from '../lib/forecast/SolarForecast.js';
import { SolisCloudTransport } from '../lib/solis/SolisCloudTransport.js';
import { SolisCloudClient } from '../lib/solis/SolisCloudClient.js';
import { addDays, localDate } from '../lib/time.js';

const TZ = 'Europe/Stockholm';
const env = Object.fromEntries(readFileSync('../.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const { lat, lon } = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { lat: number; lon: number };
const array = { kwp: 9.4, tilt: 30, azimuth: -30 };
const credentials = { keyId: env.KEY_ID, keySecret: env.KEY_SECRET };
const [inverter] = await new SolisCloudClient(credentials).inverterList();
const transport = new SolisCloudTransport(credentials, String(inverter.sn));

// Measured PV per quarter-hour, leaving out throttled samples.
const sums = new Map<number, { sum: number; n: number }>();
for (let d = 14; d >= 1; d--) {
  const date = localDate(addDays(new Date(), -d), TZ);
  for (const s of await transport.getHistory(date, TZ)) {
    if (looksCurtailed(s.pvW / 1000, s.loadW / 1000, s.gridW / 1000, s.batteryW / 1000) || !Number.isFinite(s.pvW)) continue;
    const q = Math.floor(s.time.getTime() / 900_000) * 900_000;
    const e = sums.get(q) ?? { sum: 0, n: 0 };
    e.sum += s.pvW / 1000;
    e.n++;
    sums.set(q, e);
  }
}
const actual = new Map([...sums].map(([q, e]) => [q, e.sum / e.n]));

const models = await new OpenMeteoProvider().getModels(lat, lon, array, 14);
const power = new Map([...models].map(([m, series]) => [m, new Map(series.map((irr) => [irr.start.getTime(), modelPvKw(irr, array, 0.85)]))]));
const quarters = [...actual.keys()].filter((q) => [...power.values()].every((p) => p.has(q))).sort((a, b) => a - b);

// Calibration on the median (as the app does), then each model scored after it.
const calibration = new SolarCalibration(TZ);
for (const q of quarters) calibration.add(new Date(q), median([...power.values()].map((p) => p.get(q)!))!, actual.get(q)!, array.kwp);
const skill = new ModelSkill();
const err: Record<string, number[]> = {};
for (const q of quarters) {
  const f = calibration.factorAt(new Date(q));
  const predictions = Object.fromEntries([...power].map(([m, p]) => [m, p.get(q)! * f]));
  const a = actual.get(q)!;
  if (Math.max(a, ...Object.values(predictions)) < 0.05 * array.kwp) continue;
  skill.add(predictions, a, array.kwp);
  for (const [m, v] of Object.entries(predictions)) (err[m] ??= []).push(Math.abs(v - a));
  const med = median(Object.values(predictions))!;
  (err.median ??= []).push(Math.abs(med - a));
}
// Weighted average with the weights learned from the first week, scored on the second (out of sample).
const half = quarters[Math.floor(quarters.length / 2)];
const early = new ModelSkill();
for (const q of quarters.filter((q) => q < half)) {
  const f = calibration.factorAt(new Date(q));
  early.add(Object.fromEntries([...power].map(([m, p]) => [m, p.get(q)! * f])), actual.get(q)!, array.kwp);
}
const w = early.weights(BLEND_MODELS, array.kwp)!;
const late: Record<string, number[]> = { weighted: [], median: [] };
for (const q of quarters.filter((q) => q >= half)) {
  const f = calibration.factorAt(new Date(q));
  const predictions = Object.fromEntries([...power].map(([m, p]) => [m, p.get(q)! * f]));
  const a = actual.get(q)!;
  if (Math.max(a, ...Object.values(predictions)) < 0.05 * array.kwp) continue;
  late.weighted.push(Math.abs(Object.entries(predictions).reduce((s, [m, v]) => s + w[m] * v, 0) - a));
  late.median.push(Math.abs(median(Object.values(predictions))! - a));
  for (const [m, v] of Object.entries(predictions)) (late[m] ??= []).push(Math.abs(v - a));
}
const mae = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
console.log('Second week, with weights learned from the first week:');
for (const [m, xs] of Object.entries(late).sort((a, b) => mae(a[1]) - mae(b[1]))) {
  console.log(`  ${(MODEL_NAMES[m] ?? m).padEnd(14)} mean error ${mae(xs).toFixed(2)} kW`);
}
console.log(`Daylight quarters scored: ${err.median.length} (14 days, throttled quarters left out)`);
for (const [m, xs] of Object.entries(err).sort((a, b) => mae(a[1]) - mae(b[1]))) {
  console.log(`  ${(MODEL_NAMES[m] ?? m).padEnd(14)} mean error ${mae(xs).toFixed(2)} kW`);
}
console.log('Weights the app would use:', skill.describe(BLEND_MODELS, array.kwp));
process.exit(0);
