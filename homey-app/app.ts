import { randomBytes, timingSafeEqual } from 'node:crypto';

import Homey from 'homey';

import type SolisInverterDevice from './drivers/solis-inverter/device.js';

/** Where the standalone dashboard page is published (GitHub Pages of the project). */
const DASHBOARD_PAGE = 'https://lorkster.github.io/solis-integration/dashboard/';

export default class SolisBatteryApp extends Homey.App {
  override async onInit(): Promise<void> {
    this.log('Solis Smart Battery started');
  }

  /** State of the first paired inverter, for the dashboard widgets. */
  getView(): unknown {
    const [device] = this.homey.drivers.getDriver('solis-inverter').getDevices() as SolisInverterDevice[];
    return device ? device.getView() : { ready: false, paired: false };
  }

  /** The same view for the read-only dashboard link, only when it is switched on and the key matches. */
  getPublicView(key: string): unknown {
    const expected = this.homey.settings.get('dashboardKey') as string | null;
    const ok = Boolean(this.homey.settings.get('dashboardEnabled')) && expected !== null
      && key.length === expected.length && timingSafeEqual(Buffer.from(key), Buffer.from(expected));
    if (!ok) throw new Error('The dashboard link is switched off or the key is wrong');
    return this.getView();
  }

  /** Link for a browser or wall screen on the home network (Homey's local HTTPS address). */
  async dashboardLink(): Promise<{ enabled: boolean; url: string | null; homey: string | null }> {
    const key = this.ensureKey();
    const address = await this.homey.cloud.getLocalAddress().catch(() => '');
    const ip = address.split(':')[0];
    const homey = /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `https://${ip.replace(/\./g, '-')}.homey.homeylocal.com` : null;
    return {
      enabled: Boolean(this.homey.settings.get('dashboardEnabled')),
      homey,
      // The address and key travel in the #fragment, which the browser never sends to the page's host.
      url: homey ? `${DASHBOARD_PAGE}#homey=${encodeURIComponent(homey)}&key=${key}` : null,
    };
  }

  async setDashboardLink(change: { enabled?: boolean; newKey?: boolean }): Promise<unknown> {
    if (change.newKey) this.homey.settings.set('dashboardKey', randomBytes(18).toString('hex'));
    if (change.enabled !== undefined) this.homey.settings.set('dashboardEnabled', change.enabled);
    return this.dashboardLink();
  }

  private ensureKey(): string {
    let key = this.homey.settings.get('dashboardKey') as string | null;
    if (!key) {
      key = randomBytes(18).toString('hex');
      this.homey.settings.set('dashboardKey', key);
    }
    return key;
  }
}
