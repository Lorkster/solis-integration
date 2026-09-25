// Regenerates the parts of docs/USER-GUIDE.md that describe the app's device values, settings and
// flow cards, straight from the app's manifest files, and renders the widget screenshots.
// Usage: node tools/gen-docs.mjs            (needs Microsoft Edge for the screenshots)
//        node tools/gen-docs.mjs --no-images
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'homey-app');
const guidePath = join(root, 'docs', 'USER-GUIDE.md');
const read = (p) => JSON.parse(readFileSync(join(app, p), 'utf8'));

// The Solis driver with the shared battery-planner template and settings groups filled in, as Homey Compose does.
const driver = (() => {
  const own = read('drivers/solis-inverter/driver.compose.json');
  const base = Object.assign({}, ...(own.$extends ?? []).map((t) => read(`.homeycompose/drivers/templates/${t}.json`)));
  const settings = own.settings.map((s) => (s.$extends ? read(`.homeycompose/drivers/settings/${s.$extends}.json`) : s));
  return { ...base, ...own, settings };
})();
// App-wide flow cards, one file per card, named with a number for their order in the Flow editor.
const flow = Object.fromEntries(['triggers', 'conditions', 'actions'].map((type) => [type,
  readdirSync(join(app, '.homeycompose/flow', type)).sort().map((f) => read(`.homeycompose/flow/${type}/${f}`))]));
const customCaps = Object.fromEntries(readdirSync(join(app, '.homeycompose/capabilities'))
  .map((f) => [f.replace('.json', ''), read(`.homeycompose/capabilities/${f}`)]));

/** What each device value means, written for the user. Keyed by capability id. */
const MEANING = {
  measure_battery: 'Battery state of charge.',
  measure_power: 'Battery power. Positive while charging, negative while discharging. Used by Homey Energy.',
  solis_power_source: 'Which sources power the house right now: solar, battery and/or grid. A source counts when it delivers at least 100 W and 5 % of the consumption.',
  solis_power_level: 'Whether extra power is cheap, normal or expensive right now: the cost of extra power compared with the limits in the settings (automatically: the cheapest and priciest quarter of the next 24 hours). Made for shifting a heat pump\'s temperature.',
  measure_solis_power_cost: 'What one more kWh costs right now: the import price while buying from the grid, the export income you give up while selling solar, otherwise what the battery\'s energy is worth later (from the plan). The best value to base "run it now?" automations on.',
  solis_control_mode: '*Monitor only*: the app plans and shows, but never changes the inverter. *Automatic*: the app writes the charging schedule to the inverter.',
  solis_plan_status: 'What happens now and the next battery periods, e.g. "Battery powers house until 21:00 · Grid charging 13:45–15:30".',
  measure_solis_price: 'What you pay per kWh bought right now, including fees, taxes and VAT.',
  measure_solis_pv: 'Total solar panel production.',
  measure_solis_load: 'Total house consumption.',
  measure_solis_grid: 'Power to or from the grid. Positive while buying, negative while selling.',
  measure_solis_surplus: 'Solar production beyond the house consumption. It goes into the battery or to the grid.',
  measure_solis_solar_share: 'Share of the house consumption covered by solar right now.',
  measure_solis_battery_share: 'Share of the house consumption covered by the battery right now.',
  measure_solis_grid_share: 'Share of the house consumption bought from the grid right now.',
  measure_solis_pv_forecast: 'Expected solar production for the whole day, from the forecast calibrated against your panels.',
  measure_solis_reserve: 'Battery level kept for power outages right now (seasonal, raised during weather warnings).',
  measure_solis_backup_hours: 'How long the battery would last in a power outage at the current consumption, down to the inverter\'s outage limit.',
  alarm_solis_battery_locked: 'On when a leftover SolisCloud command keeps the battery at 0 A. See the troubleshooting section.',
  solis_dashboard: 'Hidden: the data for the dashboard page (see Dashboard in a browser). Not shown in Homey.',
  alarm_solis_power_cut: 'On while the inverter sees no grid voltage: the battery powers the backup output.',
  alarm_solis_off_plan: 'On when the battery has not done what the plan says for 20 minutes, or no data has arrived for 20 minutes. The device’s warning line says what is wrong.',
  measure_solis_saved_today: 'What the battery saved today: the actual electricity cost compared with the same consumption and solar without a battery. Unit follows the price area’s currency.',
  measure_solis_saved_month: 'What the battery saved this month, including a lower power fee when that is switched on.',
  measure_solis_peak_month: 'Only with a power fee: the average of this month’s highest peaks so far, which the fee is based on.',
  measure_solis_peak_now: 'Only with a power fee: the average import this hour (or quarter) is heading for, weighted like the grid company does.',
  alarm_solis_weather: 'On while a weather warning covers Homey\'s location.',
  solis_warning: 'Text of the active weather warning(s).',
  'meter_power.charged': 'Total energy charged into the battery. Used by Homey Energy.',
  'meter_power.discharged': 'Total energy discharged from the battery. Used by Homey Energy.',
};

const SYSTEM_TITLES = {
  measure_battery: { en: 'Battery', sv: 'Batteri' },
  'meter_power.charged': driver.capabilitiesOptions['meter_power.charged'].title,
  'meter_power.discharged': driver.capabilitiesOptions['meter_power.discharged'].title,
  measure_power: driver.capabilitiesOptions.measure_power.title,
};

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const card = (title) => title.en.replace(/!\{\{([^|]*)\|([^}]*)\}\}/g, '$1 / $2').replace(/\[\[(\w+)\]\]/g, '*[$1]*');

function capabilitiesTable() {
  const rows = driver.capabilities.map((id) => {
    const c = customCaps[id];
    const title = SYSTEM_TITLES[id] ?? c?.title ?? { en: id };
    const unit = c?.units?.en ?? (id === 'measure_battery' ? '%' : id === 'measure_power' ? 'W' : id.startsWith('meter_power') ? 'kWh' : '');
    const values = c?.type === 'enum' ? `<br>Values: ${c.values.map((v) => v.title.en).join(', ')}` : '';
    if (!MEANING[id]) throw new Error(`No user description for capability ${id}`);
    return `| **${esc(title.en)}** | ${esc(title.sv ?? '')} | ${unit} | ${esc(MEANING[id])}${values} |`;
  });
  return ['| Value | In Swedish | Unit | What it means |', '|---|---|---|---|', ...rows].join('\n');
}

function settingsTable() {
  const out = [];
  for (const group of driver.settings) {
    out.push(`**${group.label.en}**`, '', '| Setting | Default | What it does |', '|---|---|---|');
    for (const s of group.children) {
      let def = s.value;
      if (s.type === 'checkbox') def = s.value ? 'on' : 'off';
      if (s.type === 'dropdown') def = s.values.find((v) => v.id === s.value)?.label.en ?? s.value;
      if (s.type === 'password' || (s.type === 'text' && !s.value)) def = '(from pairing)';
      const unit = s.units?.en && typeof s.value === 'number' ? ` ${s.units.en}` : '';
      out.push(`| ${esc(s.label.en)} | ${esc(`${def}${unit}`)} | ${esc(s.hint?.en ?? '')} |`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

function flowTables() {
  const section = (name, cards, extra) => [
    `**${name}**`, '', `| Card | ${extra === 'Tokens' ? 'Notes' : extra} |`, '|---|---|',
    ...cards.map((c) => `| ${esc(card(c.titleFormatted ?? c.title))} | ${esc(
      extra === 'Tokens'
        ? [c.hint?.en, c.tokens?.length ? `Tokens: ${c.tokens.map((t) => t.title.en).join(', ')}` : ''].filter(Boolean).join(' ')
        : c.hint?.en ?? '',
    )} |`),
    '',
  ].join('\n');
  return [
    section('When… (triggers)', flow.triggers, 'Tokens'),
    section('And… (conditions)', flow.conditions, 'Notes'),
    section('Then… (actions)', flow.actions, 'Notes'),
  ].join('\n').trim();
}

let guide = readFileSync(guidePath, 'utf8');
for (const [name, content] of [['capabilities', capabilitiesTable()], ['settings', settingsTable()], ['flows', flowTables()]]) {
  const re = new RegExp(`(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`);
  if (!re.test(guide)) throw new Error(`Marker for ${name} missing in USER-GUIDE.md`);
  guide = guide.replace(re, `$1\n<!-- Generated by tools/gen-docs.mjs from the app manifest. Do not edit by hand. -->\n\n${content}\n\n$2`);
}
writeFileSync(guidePath, guide);
console.log('Updated', guidePath);

if (!process.argv.includes('--no-images')) {
  const images = join(root, 'docs', 'images');
  mkdirSync(images, { recursive: true });
  // A power cut with the power fee switched on: the banner and the peak tile.
  const mockLive = JSON.parse(readFileSync(join(root, 'tools/widget-preview/mock-view.json'), 'utf8')).live;
  const powerCut = JSON.stringify({
    live: { ...mockLive, gridW: 0, loadW: 4600 },
    powerCut: { since: '2026-09-24T12:05:00Z' },
    peak: { monthKw: 4.3, thresholdKw: 4.1, nowKw: 0, risk: false },
    supply: { source: 'solar_battery', title: 'Solar + battery', solarPct: 70, batteryPct: 30, gridPct: 0, surplusW: 0 },
  });
  const renders = [
    ['battery-plan', 'light', 780, 'battery-plan-light'], ['battery-plan', 'dark', 780, 'battery-plan-dark'],
    ['battery-status', 'light', 620, 'battery-status-light'], ['battery-status', 'dark', 620, 'battery-status-dark'],
    ['battery-status', 'light', 680, 'battery-status-power-cut', powerCut],
  ];
  for (const [widget, theme, height, name, override] of renders) {
    {
      const out = join(images, `${name}.png`);
      execFileSync('node', [join(root, 'tools/widget-preview/render.mjs'), widget, theme, '384', String(height), out],
        { env: { ...process.env, MOCK_OVERRIDE: override ?? '' } });
      // Trim empty space below the card.
      execFileSync('python', ['-c', `
from PIL import Image
im = Image.open(r"${out}").convert("RGB"); bg = im.getpixel((2, im.height - 2)); b = im.height
while b > 0 and all(im.getpixel((x, b - 1)) == bg for x in range(0, 768, 16)): b -= 1
im.crop((0, 0, 768, min(im.height, b + 24))).save(r"${out}", optimize=True)`]);
      console.log('Rendered', out);
    }
  }
}
