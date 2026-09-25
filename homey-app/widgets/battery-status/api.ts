import type BatteryPlannerApp from '../../app.js';

export default {
  async getPlan({ homey }: { homey: { app: BatteryPlannerApp } }): Promise<unknown> {
    return homey.app.getView();
  },
};
