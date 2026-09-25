import { EnergyChildDriver } from '../../lib/homey/EnergyChildDevice.js';

export default class GridDriver extends EnergyChildDriver {
  protected override suffix = 'grid';
  protected override nameKey = 'child.gridName';
}
