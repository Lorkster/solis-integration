import { EnergyChildDriver } from '../../lib/homey/EnergyChildDevice.js';

export default class SolarDriver extends EnergyChildDriver {
  protected override suffix = 'solar';
  protected override nameKey = 'child.solarName';
}
