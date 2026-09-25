import type SolisBatteryApp from './app.js';

type Args = { homey: { app: SolisBatteryApp }; query: Record<string, string>; body: Record<string, unknown> };

/** App web API: the dashboard in the app's settings page and the read-only dashboard link. */
export default {
  async getView({ homey }: Args): Promise<unknown> {
    return homey.app.getView();
  },

  /** Public (no Homey login), for a wall screen on the home network: needs the link's key. */
  async getDashboard({ homey, query }: Args): Promise<unknown> {
    return homey.app.getPublicView(String(query.key ?? ''));
  },

  async getDashboardLink({ homey }: Args): Promise<unknown> {
    return homey.app.dashboardLink();
  },

  async setDashboardLink({ homey, body }: Args): Promise<unknown> {
    return homey.app.setDashboardLink({ enabled: body.enabled as boolean | undefined, newKey: Boolean(body.newKey) });
  },
};
