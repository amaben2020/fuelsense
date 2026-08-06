// Single source of truth for every alert the platform can raise.
//
// The Documentation page renders straight from this, so what a manager reads
// can never drift from what the engines actually emit. Adding an alert type
// without adding it here means it appears in the feed undocumented — treat
// this file as part of shipping a new alert, not an afterthought.

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertDefinition {
  type: string;
  label: string;
  severity: AlertSeverity;
  /** What the manager should understand it to mean. */
  meaning: string;
  /** The actual condition, stated plainly enough to be checkable. */
  trigger: string;
  /** Where it comes from — matters because device scenarios need the tracker
   *  configured, while analysis alerts work on GPS alone. */
  source: 'analysis' | 'device';
  /** True where the alert is emailed as well as shown in-app. */
  emailable: boolean;
}

export const ALERT_CATALOGUE: AlertDefinition[] = [
  {
    type: 'receipt_uploaded',
    label: 'Driver filed a fuel receipt',
    severity: 'info',
    meaning:
      'A driver submitted a fuel purchase from the driver app, with the station location captured by their phone.',
    trigger:
      'Any successful receipt submission. The email carries the station name, address, a photo of the location, the volume and the amount.',
    source: 'analysis',
    emailable: true,
  },
  {
    type: 'trip_start',
    label: 'Vehicle started a trip',
    severity: 'info',
    meaning: 'A vehicle has been taken out and is beginning a journey.',
    trigger:
      'Ignition switches from off to on. Repeat starts within 15 minutes are treated as one journey, so a stall-and-restart does not notify twice.',
    source: 'analysis',
    emailable: true,
  },
  {
    type: 'fuel_theft',
    label: 'Possible fuel theft',
    severity: 'critical',
    meaning:
      'Fuel level fell sharply while the vehicle was stationary — consistent with siphoning rather than driving.',
    trigger:
      'A drop beyond the vehicle-specific threshold within 30 minutes, while parked, that does not recover afterwards. Requires a fuel-level source; GPS-only vehicles cannot raise this.',
    source: 'analysis',
    emailable: false,
  },
  {
    type: 'receipt_fraud',
    label: 'Receipt does not match',
    severity: 'critical',
    meaning:
      'A receipt the tracker contradicts — the vehicle was not at that station, or the claimed volume could not have fitted in the tank.',
    trigger:
      'Verification finds the vehicle more than 3 km from the receipt location at the purchase time, or declared litres above the tank’s available room.',
    source: 'analysis',
    emailable: false,
  },
  {
    type: 'unlogged_fill',
    label: 'Fill with no receipt',
    severity: 'warning',
    meaning:
      'The vehicle stopped at a filling station and no receipt was ever logged for it, so whatever was bought is unaccounted for.',
    trigger:
      'A stop of 3–45 minutes at a place Google identifies as a filling station, with no receipt within ±2 hours of it.',
    source: 'analysis',
    emailable: false,
  },
  {
    type: 'low_fuel',
    label: 'Low fuel',
    severity: 'warning',
    meaning: 'The modelled tank has fallen to a level worth planning a refuel around.',
    trigger:
      'Virtual tank drops to 15% or less of capacity. Based on the calculated level, not a tank sensor. The email states the model confidence alongside the level.',
    source: 'analysis',
    emailable: true,
  },
  {
    type: 'excessive_idle',
    label: 'Excessive idling',
    severity: 'warning',
    meaning: 'The engine ran for a long stretch without the vehicle moving.',
    trigger: 'Ignition on with speed below 2 km/h for a sustained period.',
    source: 'analysis',
    emailable: false,
  },
  {
    type: 'idle_fuel_waste',
    label: 'Fuel wasted idling',
    severity: 'warning',
    meaning:
      'The engine is burning noticeably more than this vehicle normally does while stationary.',
    trigger:
      'Stationary for 5+ minutes at a burn rate above 1.5x the vehicle’s learned idle rate. Needs the tracker’s fuel-rate element.',
    source: 'analysis',
    emailable: false,
  },
  {
    type: 'overspeeding',
    label: 'Overspeeding',
    severity: 'warning',
    meaning: 'The vehicle exceeded the speed limit configured on the tracker.',
    trigger: 'Tracker reports its overspeed scenario. Requires that scenario enabled on the device.',
    source: 'device',
    emailable: false,
  },
  {
    type: 'towing',
    label: 'Possible towing',
    severity: 'critical',
    meaning: 'The vehicle moved with the ignition off — it may be being towed or stolen.',
    trigger: 'Tracker reports movement without ignition.',
    source: 'device',
    emailable: false,
  },
  {
    type: 'crash',
    label: 'Crash detected',
    severity: 'critical',
    meaning: 'A high-force impact was registered.',
    trigger: 'Accelerometer exceeds the crash threshold configured on the tracker.',
    source: 'device',
    emailable: false,
  },
  {
    type: 'jamming_start',
    label: 'Signal jamming',
    severity: 'critical',
    meaning:
      'GPS or GSM interference near the vehicle — often deliberate, to stop it being tracked.',
    trigger: 'Tracker reports jamming. Clears automatically when the signal recovers.',
    source: 'device',
    emailable: false,
  },
  {
    type: 'power_unplug',
    label: 'Tracker disconnected',
    severity: 'critical',
    meaning: 'The tracker lost vehicle power and fell back to its internal battery.',
    trigger: 'Tracker reports unplug. Clears when power is restored.',
    source: 'device',
    emailable: false,
  },
  {
    type: 'geofence_exit',
    label: 'Left permitted area',
    severity: 'warning',
    meaning: 'The vehicle left a zone it was expected to stay inside.',
    trigger: 'Tracker reports a geofence exit. Requires geofences configured on the device.',
    source: 'device',
    emailable: false,
  },
];

export const EMAILABLE_ALERTS = ALERT_CATALOGUE.filter((a) => a.emailable);

export function alertDefinition(type: string): AlertDefinition | undefined {
  return ALERT_CATALOGUE.find((a) => a.type === type);
}
