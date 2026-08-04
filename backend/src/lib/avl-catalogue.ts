// Human-readable names, units and scaling for the AVL IO elements a Teltonika
// FMx device sends.
//
// The device decides which of these it transmits — our FMC150 currently sends
// 15 of them. Anything not listed here still reaches the UI as "AVL <id>" with
// its raw value rather than being silently dropped, so enabling a new element
// in the configurator surfaces it without a code change.
//
// Scaling follows Teltonika's protocol docs: several elements are transmitted
// as integers with an implied divisor (fuel rate ×100, DOP ×10, voltages in
// millivolts).

export type SignalGroup = 'engine' | 'fuel' | 'movement' | 'electrical' | 'network' | 'gnss';

export interface AvlDefinition {
  label: string;
  group: SignalGroup;
  /**
   * What the signal means to a fleet manager, not to a protocol engineer —
   * shown as the tooltip in the vehicle data table. Says what the number is,
   * where it comes from, and what a normal reading looks like.
   */
  description?: string;
  unit?: string;
  /** Divisor applied to the raw integer to get the display value. */
  scale?: number;
  /** Decimal places for the scaled value. */
  precision?: number;
  /** Enumerated values, for elements where the number is a state code. */
  states?: Record<number, string>;
}

const ON_OFF: Record<number, string> = { 0: 'Off', 1: 'On' };

export const AVL_CATALOGUE: Record<number, AvlDefinition> = {
  1: { label: 'Digital input 1', group: 'electrical', states: ON_OFF },
  2: { label: 'Digital input 2', group: 'electrical', states: ON_OFF },
  3: { label: 'Digital input 3', group: 'electrical', states: ON_OFF },
  9: { label: 'Analog input 1', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },
  10: { label: 'Analog input 2', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },

  12: {
    label: 'Fuel used (GPS)',
    group: 'fuel',
    unit: 'L',
    scale: 1000,
    precision: 2,
    description:
      'Running total of fuel burned, estimated by the tracker from engine load and speed. It counts up until the device loses power, then restarts at zero — the virtual tank is built from the increases, not from the total itself.',
  },
  13: {
    label: 'Fuel rate (GPS)',
    group: 'fuel',
    unit: 'L/h',
    scale: 100,
    precision: 2,
    description:
      'How fast fuel is burning right now, in litres per hour. Roughly 2 L/h is a typical idling engine; 0 means the engine is off. This is the tracker’s own estimate, not a reading from a fuel sensor.',
  },
  16: {
    label: 'Total odometer',
    group: 'movement',
    unit: 'km',
    scale: 1000,
    precision: 1,
    description:
      'Distance the tracker has measured since it was fitted, from GPS. This is not the dashboard odometer — it started at zero on installation day.',
  },
  17: { label: 'Accelerometer X', group: 'movement', unit: 'mG' },
  18: { label: 'Accelerometer Y', group: 'movement', unit: 'mG' },
  19: { label: 'Accelerometer Z', group: 'movement', unit: 'mG' },
  21: {
    label: 'GSM signal strength',
    group: 'network',
    unit: '/5',
    description:
      'Mobile signal where the vehicle is, from 0 to 5. Low signal does not lose data — the tracker stores records and sends them in a burst once it reconnects, so they arrive late rather than never.',
  },
  24: {
    label: 'Speed',
    group: 'movement',
    unit: 'km/h',
    description:
      'Speed measured from GPS, not from the speedometer. A few km/h while parked is normal receiver noise, which is why anything under 2 km/h counts as stationary.',
  },

  // OBD / CAN elements. Absent on a tracker with no adapter fitted — listed so
  // they appear automatically the day one is.
  30: { label: 'Diagnostic trouble codes', group: 'engine', description: 'How many fault codes the engine computer is currently reporting. Anything above zero means the dashboard warning light has a stored reason behind it.' },
  31: { label: 'Engine load', group: 'engine', unit: '%', description: 'How hard the engine is working as a percentage of its maximum. High sustained load on a light vehicle usually means heavy acceleration or a heavy payload.' },
  32: { label: 'Coolant temperature', group: 'engine', unit: '°C', description: 'Engine coolant temperature. Normal running is roughly 80–100 °C; a sustained climb above that is an overheating risk.' },
  36: { label: 'Engine RPM', group: 'engine', unit: 'rpm', description: 'Engine revolutions per minute. Useful for spotting over-revving, and for telling a running engine from one that is merely switched on.' },
  37: { label: 'Vehicle speed (OBD)', group: 'movement', unit: 'km/h', description: 'Speed as the vehicle itself reports it, taken from the engine computer. More accurate than GPS speed at low speeds.' },
  39: { label: 'Intake air temperature', group: 'engine', unit: '°C' },
  41: { label: 'Throttle position', group: 'engine', unit: '%', description: 'How far the accelerator is pressed. Repeated jumps to full throttle are a sign of aggressive driving.' },
  42: { label: 'Runtime since engine start', group: 'engine', unit: 's', description: 'How long the engine has been running since it was last started.' },
  48: {
    label: 'Fuel level (OBD)',
    group: 'fuel',
    unit: '%',
    description:
      'Fuel in the tank as a percentage, read from the vehicle’s own fuel gauge. When this is available FuelSense trusts it over the estimated virtual tank.',
  },
  51: { label: 'Control module voltage', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },
  53: { label: 'Ambient air temperature', group: 'engine', unit: '°C' },

  66: {
    label: 'External voltage',
    group: 'electrical',
    unit: 'V',
    scale: 1000,
    precision: 2,
    description:
      'Voltage on the vehicle battery feeding the tracker. Around 12 V parked and 13.5–14.5 V with the engine running; a drop toward 11 V suggests a failing battery or a bad connection.',
  },
  67: {
    label: 'Battery voltage',
    group: 'electrical',
    unit: 'V',
    scale: 1000,
    precision: 2,
    description:
      'Charge in the tracker’s own backup battery, which keeps it reporting if the vehicle battery is disconnected.',
  },
  68: {
    label: 'Battery current',
    group: 'electrical',
    unit: 'mA',
    description:
      'Current flowing into or out of the tracker’s backup battery. Zero means it is neither charging nor discharging — normal for a fully charged device on vehicle power.',
  },
  69: {
    label: 'GNSS status',
    group: 'gnss',
    states: { 0: 'Off', 1: 'On, no fix', 2: 'On, fix', 3: 'Sleep' },
    description:
      'Whether the satellite receiver is on and whether it has locked onto a position. “On, no fix” means it is still searching — common under cover, in a garage, or in the first minute after waking.',
  },
  113: { label: 'Battery level', group: 'electrical', unit: '%' },

  181: {
    label: 'GNSS PDOP',
    group: 'gnss',
    scale: 10,
    precision: 1,
    description:
      'How well spread the visible satellites are, which sets the overall quality of the position. Below 2 is excellent, above 5 means the location should not be trusted.',
  },
  182: {
    label: 'GNSS HDOP',
    group: 'gnss',
    scale: 10,
    precision: 1,
    description:
      'The same quality measure limited to horizontal accuracy — the part that matters for where the vehicle is on the map. Lower is better; below 1 is excellent.',
  },
  199: {
    label: 'Trip odometer',
    group: 'movement',
    unit: 'km',
    scale: 1000,
    precision: 2,
    description:
      'Distance covered since the tracker considered the current trip to have started. It resets to zero at the beginning of each trip.',
  },
  200: {
    label: 'Sleep mode',
    group: 'electrical',
    states: { 0: 'No sleep', 1: 'GPS sleep', 2: 'Deep sleep', 3: 'Online sleep', 4: 'Ultra sleep' },
    description:
      'The tracker’s power-saving state while the vehicle is parked. Deeper sleep preserves the vehicle battery but reports less often, so positions arrive further apart.',
  },
  205: { label: 'GSM cell ID', group: 'network', description: 'The mobile mast the tracker is currently attached to. A rough location fallback when there is no satellite fix.' },
  206: { label: 'GSM area code', group: 'network' },

  239: {
    label: 'Ignition',
    group: 'engine',
    states: ON_OFF,
    description:
      'Whether the key is turned on and the engine is live. This is the signal FuelSense uses to start and end trips, and to tell idling apart from a vehicle that is simply parked.',
  },
  240: {
    label: 'Movement',
    group: 'movement',
    states: { 0: 'Stopped', 1: 'Moving' },
    description:
      'The tracker’s own decision about whether the vehicle is moving, from its motion sensor. It also sets the reporting rate: moving sends frequently, stopped drops to about one record an hour.',
  },
  241: {
    label: 'GSM operator',
    group: 'network',
    description: 'The mobile network the tracker’s SIM is currently connected to.',
  },
  449: {
    label: 'Ignition on counter',
    group: 'engine',
    description:
      'How many times the ignition has been switched on since the counter was last reset on the device.',
  },

  389: {
    label: 'OEM total mileage',
    group: 'movement',
    unit: 'km',
    description:
      'The real dashboard odometer, read from the vehicle’s own computer. Unlike the tracker odometer, this is the number a buyer or mechanic would see.',
  },
  390: { label: 'OEM fuel level', group: 'fuel', unit: 'L', scale: 100, precision: 2, description: 'Litres in the tank as reported by the vehicle itself — the most trustworthy fuel reading available, when the hardware supports it.' },
};

// MCC+MNC of the networks this fleet roams on. Anything unmapped falls back to
// the raw code rather than guessing at a carrier name.
const GSM_OPERATORS: Record<number, string> = {
  62120: 'Airtel NG',
  62130: 'MTN NG',
  62150: 'Glo NG',
  62160: '9mobile NG',
};

export interface DecodedSignal {
  avl_id: number;
  label: string;
  description: string | null;
  group: SignalGroup | 'other';
  raw: number;
  /** Scaled numeric value, or null for elements that are purely enumerated. */
  value: number | null;
  unit: string | null;
  /** Ready-to-render string, including unit and any state name. */
  display: string;
  known: boolean;
}

export function decodeSignal(avlId: number, raw: number): DecodedSignal {
  const def = AVL_CATALOGUE[avlId];

  if (!def) {
    return {
      avl_id: avlId,
      label: `AVL ${avlId}`,
      description: null,
      group: 'other',
      raw,
      value: raw,
      unit: null,
      display: String(raw),
      known: false,
    };
  }

  if (avlId === 241) {
    return {
      avl_id: avlId,
      label: def.label,
      description: def.description ?? null,
      group: def.group,
      raw,
      value: null,
      unit: null,
      display: GSM_OPERATORS[raw] ?? String(raw),
      known: true,
    };
  }

  if (def.states) {
    return {
      avl_id: avlId,
      label: def.label,
      description: def.description ?? null,
      group: def.group,
      raw,
      value: null,
      unit: null,
      display: def.states[raw] ?? String(raw),
      known: true,
    };
  }

  const scaled = def.scale ? raw / def.scale : raw;
  const value = def.precision != null ? Number(scaled.toFixed(def.precision)) : scaled;

  return {
    avl_id: avlId,
    label: def.label,
    description: def.description ?? null,
    group: def.group,
    raw,
    value,
    unit: def.unit ?? null,
    display: def.unit ? `${value} ${def.unit}` : String(value),
    known: true,
  };
}
