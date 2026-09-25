// Renders the app and driver images from SVG illustrations with headless Edge.
// Usage: node tools/widget-preview/images.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../homey-app');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// App image, 10:7. Battery with charge level, sun, and a day-ahead price curve with cheap hours marked.
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f59e3b"/><stop offset="1" stop-color="#c2410c"/></linearGradient>
    <linearGradient id="cell" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity=".95"/><stop offset="1" stop-color="#ffffff" stop-opacity=".75"/></linearGradient>
  </defs>
  <rect width="1000" height="700" fill="url(#bg)"/>
  <circle cx="800" cy="170" r="70" fill="#ffe7b0"/>
  <g stroke="#ffe7b0" stroke-width="14" stroke-linecap="round">
    <path d="M800 55v-20M800 305v-20M685 170h-20M935 170h-20M719 89l-14-14M895 265l-14-14M719 251l-14 14M895 75l-14 14"/>
  </g>
  <path d="M60 560 L120 555 L180 540 L240 470 L290 430 L340 470 L400 520 L460 530 L520 525 L580 520 L640 450 L700 410 L760 440 L820 500 L880 530 L940 540"
    fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>
  <rect x="400" y="545" width="200" height="70" rx="12" fill="#ffffff" fill-opacity=".22"/>
  <rect x="60" y="555" width="120" height="60" rx="12" fill="#ffffff" fill-opacity=".22"/>
  <rect x="330" y="150" width="240" height="380" rx="42" fill="none" stroke="#ffffff" stroke-width="22"/>
  <rect x="410" y="112" width="80" height="34" rx="10" fill="#ffffff"/>
  <rect x="362" y="302" width="176" height="196" rx="20" fill="url(#cell)"/>
  <path d="M470 330 L420 420 H462 L440 480 L500 390 H458 Z" fill="#c2410c"/>
</svg>`;

// Driver image, square on white: inverter above a stacked battery, simple product illustration.
const driverSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#ffffff"/>
  <rect x="300" y="120" width="400" height="330" rx="36" fill="#f4f4f5" stroke="#d4d4d8" stroke-width="8"/>
  <rect x="360" y="190" width="170" height="110" rx="14" fill="#27272a"/>
  <rect x="380" y="212" width="90" height="12" rx="6" fill="#f59e3b"/>
  <rect x="380" y="240" width="130" height="10" rx="5" fill="#71717a"/>
  <rect x="380" y="262" width="110" height="10" rx="5" fill="#71717a"/>
  <circle cx="610" cy="205" r="16" fill="#22c55e"/>
  <rect x="360" y="350" width="280" height="16" rx="8" fill="#e4e4e7"/>
  <rect x="360" y="380" width="280" height="16" rx="8" fill="#e4e4e7"/>
  <rect x="330" y="490" width="340" height="120" rx="26" fill="#fafafa" stroke="#d4d4d8" stroke-width="8"/>
  <rect x="330" y="630" width="340" height="120" rx="26" fill="#fafafa" stroke="#d4d4d8" stroke-width="8"/>
  <rect x="330" y="770" width="340" height="120" rx="26" fill="#fafafa" stroke="#d4d4d8" stroke-width="8"/>
  <g fill="#f59e3b"><rect x="370" y="540" width="120" height="20" rx="10"/><rect x="370" y="680" width="120" height="20" rx="10"/><rect x="370" y="820" width="120" height="20" rx="10"/></g>
  <path d="M580 525 L555 570 H578 L566 600 L600 552 H577 Z" fill="#a1a1aa"/>
</svg>`;

// Solar panels device: a tilted panel array under the sun, same style as the driver image.
const solarSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#ffffff"/>
  <circle cx="740" cy="230" r="90" fill="#f59e3b"/>
  <g stroke="#f59e3b" stroke-width="22" stroke-linecap="round">
    <path d="M740 85v-35M740 410v-35M595 230h-35M920 230h-35M638 128l-25-25M867 357l-25-25M638 332l-25 25M867 103l-25 25"/>
  </g>
  <path d="M170 520 L700 520 L820 800 L90 800 Z" fill="#27272a"/>
  <g stroke="#a1a1aa" stroke-width="10">
    <path d="M300 520 L260 800M430 520 L420 800M570 520 L580 800M700 520 L750 800"/>
    <path d="M140 610 L740 610M115 705 L780 705"/>
  </g>
  <rect x="420" y="800" width="60" height="110" fill="#71717a"/>
  <rect x="330" y="900" width="240" height="24" rx="12" fill="#71717a"/>
</svg>`;

// Grid meter device: a transmission tower next to an energy meter.
const gridSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#ffffff"/>
  <g stroke="#3f3f46" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M300 120 L180 900 M300 120 L420 900 M200 330 L400 330 M150 470 L450 470 M240 600 L360 600 M195 800 L405 800 M200 330 L360 600 M400 330 L240 600 M240 600 L405 800 M360 600 L195 800"/>
  </g>
  <rect x="540" y="300" width="340" height="460" rx="36" fill="#f4f4f5" stroke="#d4d4d8" stroke-width="10"/>
  <rect x="590" y="360" width="240" height="110" rx="14" fill="#27272a"/>
  <rect x="615" y="395" width="190" height="40" rx="8" fill="#3b82f6"/>
  <circle cx="710" cy="590" r="70" fill="none" stroke="#a1a1aa" stroke-width="16"/>
  <path d="M710 590 L750 545" stroke="#3b82f6" stroke-width="16" stroke-linecap="round"/>
  <path d="M640 710 h140" stroke="#d4d4d8" stroke-width="16" stroke-linecap="round"/>
</svg>`;

/** The Edge launcher can exit before the screenshot is written: wait for the file (up to 20 s). */
function waitForFile(file) {
  const until = Date.now() + 20_000;
  while (!existsSync(file) || statSync(file).size === 0) {
    if (Date.now() > until) throw new Error(`Edge did not write ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // let it finish writing
}

function render(svg, width, height, out) {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, `<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${width}" height="${height}" `)}</body></html>`);
  const profile = mkdtempSync(join(tmpdir(), 'solis-edge-')); // own profile: never handed to a running Edge
  execFileSync(edge, ['--headless=new', `--user-data-dir=${profile}`, '--disable-gpu', '--hide-scrollbars', `--window-size=${Math.max(width, 600)},${height}`,
    `--screenshot=${out}`, `file:///${file.split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore' });
  waitForFile(out);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'shots-'));
const jobs = [
  [appSvg, 250, 175, 'assets/images/small.png'],
  [appSvg, 500, 350, 'assets/images/large.png'],
  [appSvg, 1000, 700, 'assets/images/xlarge.png'],
  [driverSvg, 75, 75, 'drivers/solis-inverter/assets/images/small.png'],
  [driverSvg, 500, 500, 'drivers/solis-inverter/assets/images/large.png'],
  [driverSvg, 1000, 1000, 'drivers/solis-inverter/assets/images/xlarge.png'],
  ...['solis-solar', 'solis-grid'].flatMap((driver) => [[75, 'small'], [500, 'large'], [1000, 'xlarge']]
    .map(([size, name]) => [driver === 'solis-solar' ? solarSvg : gridSvg, size, size, `drivers/${driver}/assets/images/${name}.png`])),
];
for (const [svg, w, h, rel] of jobs) {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  const shot = render(svg, w, h, join(tmp, `${rel.replace(/[\/]/g, "_")}`));
  // Edge enforces a minimum window width; crop to the requested size.
  execFileSync('python', ['-c', `from PIL import Image; Image.open(r"${shot}").crop((0,0,${w},${h})).save(r"${join(app, rel)}", optimize=True)`]);
  console.log(rel);
}
