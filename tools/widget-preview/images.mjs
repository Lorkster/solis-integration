// Renders the app and driver images from SVG illustrations with headless Edge.
// Usage: node tools/widget-preview/images.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

function render(svg, width, height, out) {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, `<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${width}" height="${height}" `)}</body></html>`);
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${Math.max(width, 600)},${height}`,
    `--screenshot=${out}`, `file:///${file.split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore' });
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
];
for (const [svg, w, h, rel] of jobs) {
  const shot = render(svg, w, h, join(tmp, `${w}x${h}.png`));
  // Edge enforces a minimum window width; crop to the requested size.
  execFileSync('python', ['-c', `from PIL import Image; Image.open(r"${shot}").crop((0,0,${w},${h})).save(r"${join(app, rel)}", optimize=True)`]);
  console.log(rel);
}
