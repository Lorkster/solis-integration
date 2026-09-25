// Renders a Homey widget with mock data and Homey-like styling, then screenshots it with headless Edge.
// Usage: node tools/widget-preview/render.mjs <widget-id> <light|dark> [width] [height] [out.png] [hover 0..1]
// MOCK_OVERRIDE='{"powerCut":{...}}' replaces top-level fields of the mock data.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [widget = 'battery-plan', theme = 'light', width = '400', height = '600', out, hover] = process.argv.slice(2);
// MOCK_OVERRIDE: JSON, or the path of a .json file (large overrides do not fit in an environment variable).
const override = process.env.MOCK_OVERRIDE || '{}';
const view = {
  ...JSON.parse(readFileSync(join(here, 'mock-view.json'), 'utf8')),
  ...JSON.parse(override.trim().endsWith('.json') ? readFileSync(override.trim(), 'utf8') : override),
};
const html = readFileSync(resolve(here, '../../homey-app/widgets', widget, 'public/index.html'), 'utf8');

// Approximation of Homey's widget stylesheet (only the variables the widgets use).
const vars = theme === 'dark'
  ? '--homey-background-color:#1c1c1e;--homey-text-color:#f2f2f7;--homey-text-color-light:#98989f;--homey-color-warning:#fab219;--homey-color-highlight:#0a84ff;'
  : '--homey-background-color:#ffffff;--homey-text-color:#1c1c1e;--homey-text-color-light:#8a8a8e;--homey-color-warning:#fab219;--homey-color-highlight:#007aff;';
const inject = `<style>:root{${vars}--homey-su-2:8px;--homey-su-3:12px;--homey-su-4:16px}
  html{background:${theme === 'dark' ? '#000' : '#f2f2f7'}}
  .line-flow{animation-play-state:paused!important;animation-delay:0s!important}
  body.homey-widget{width:${Number(width) - 24}px;box-sizing:border-box;padding:16px;margin:12px;border-radius:20px;background:var(--homey-background-color);box-shadow:0 1px 3px rgba(0,0,0,.1)}</style>`;
const mock = `<script>
  const VIEW = ${JSON.stringify(view)};
  window.addEventListener('load', () => onHomeyReady({
    getSettings: () => ({ hours: '36', showEnergy: true }),
    api: async () => VIEW, on: () => {}, ready: () => {}, setHeight: async () => {}, __: (k) => k,
  }));
  ${hover ? `setTimeout(() => {
    const chart = document.querySelector('.chart');
    const r = chart.getBoundingClientRect();
    chart.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * ${Number(hover)}, clientY: r.top + 40, bubbles: true }));
  }, 300);` : ''}
</script>`;
const page = html
  .replace('<body class="homey-widget">', `<body class="homey-widget${theme === 'dark' ? ' homey-dark-mode' : ''}">`)
  .replace('</head>', `${inject}</head>`)
  .replace('</body>', `${mock}</body>`);
const dir = mkdtempSync(join(tmpdir(), 'widget-'));
const file = join(dir, 'page.html');
writeFileSync(file, page);
const png = resolve(out ?? join(here, `${widget}-${theme}.png`));
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${Math.max(Number(width), 600)},${height}`,
  '--force-device-scale-factor=2', '--virtual-time-budget=3000', `--screenshot=${png}`, `file:///${file.split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore' });
console.log(png);
