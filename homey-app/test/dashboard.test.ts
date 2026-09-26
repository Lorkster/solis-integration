import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// The browser dashboards carry their own copy of the widgets (tools/build-dashboard.mjs). A widget
// change without a rebuild leaves the settings page and the standalone page on the old widgets.
const root = resolve(process.cwd(), '..'); // npm test runs in homey-app
const read = (file: string) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');

describe('browser dashboard', () => {
  for (const page of ['homey-app/settings/index.html', 'docs/dashboard/solis-dashboard.html']) {
    it(`${page} has the current widgets (run node tools/build-dashboard.mjs)`, () => {
      const html = read(page);
      for (const id of ['battery-status', 'battery-plan']) {
        const embedded = JSON.stringify(read(`homey-app/widgets/${id}/public/index.html`)).replace(/<\/(script)/gi, '<\\/$1');
        assert.ok(html.includes(embedded), `${id} is out of date in ${page}`);
      }
    });
  }
});
