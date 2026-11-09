export const PLUGIN_NAME = '@homebridge-plugins/homebridge-openeo';
export const PLATFORM_NAME = 'OpenEO';

export const MIN_AMPS = 6;
export const MAX_AMPS = 32;

// OpenEO charger state ids (openeoCharger.py CHARGER_STATES)
export const STATE = {
  MAINS_FAULT_START: 3,
  MAINS_FAULT: 4,
  CAR_CONNECTED_START: 9,
  CHARGING_START: 11,
  CHARGING: 12,
  SIMULATED: 99,
};
