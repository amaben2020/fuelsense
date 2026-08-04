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

  12: { label: 'Fuel used (GPS)', group: 'fuel', unit: 'L', scale: 1000, precision: 2 },
  13: { label: 'Fuel rate (GPS)', group: 'fuel', unit: 'L/h', scale: 100, precision: 2 },
  16: { label: 'Total odometer', group: 'movement', unit: 'km', scale: 1000, precision: 1 },
  17: { label: 'Accelerometer X', group: 'movement', unit: 'mG' },
  18: { label: 'Accelerometer Y', group: 'movement', unit: 'mG' },
  19: { label: 'Accelerometer Z', group: 'movement', unit: 'mG' },
  21: { label: 'GSM signal strength', group: 'network', unit: '/5' },
  24: { label: 'Speed', group: 'movement', unit: 'km/h' },

  // OBD / CAN elements. Absent on a tracker with no adapter fitted — listed so
  // they appear automatically the day one is.
  30: { label: 'Diagnostic trouble codes', group: 'engine' },
  31: { label: 'Engine load', group: 'engine', unit: '%' },
  32: { label: 'Coolant temperature', group: 'engine', unit: '°C' },
  36: { label: 'Engine RPM', group: 'engine', unit: 'rpm' },
  37: { label: 'Vehicle speed (OBD)', group: 'movement', unit: 'km/h' },
  39: { label: 'Intake air temperature', group: 'engine', unit: '°C' },
  41: { label: 'Throttle position', group: 'engine', unit: '%' },
  42: { label: 'Runtime since engine start', group: 'engine', unit: 's' },
  48: { label: 'Fuel level (OBD)', group: 'fuel', unit: '%' },
  51: { label: 'Control module voltage', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },
  53: { label: 'Ambient air temperature', group: 'engine', unit: '°C' },

  66: { label: 'External voltage', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },
  67: { label: 'Battery voltage', group: 'electrical', unit: 'V', scale: 1000, precision: 2 },
  68: { label: 'Battery current', group: 'electrical', unit: 'mA' },
  69: {
    label: 'GNSS status',
    group: 'gnss',
    states: { 0: 'Off', 1: 'On, no fix', 2: 'On, fix', 3: 'Sleep' },
  },
  113: { label: 'Battery level', group: 'electrical', unit: '%' },

  181: { label: 'GNSS PDOP', group: 'gnss', scale: 10, precision: 1 },
  182: { label: 'GNSS HDOP', group: 'gnss', scale: 10, precision: 1 },
  199: { label: 'Trip odometer', group: 'movement', unit: 'km', scale: 1000, precision: 2 },
  200: {
    label: 'Sleep mode',
    group: 'electrical',
    states: { 0: 'No sleep', 1: 'GPS sleep', 2: 'Deep sleep', 3: 'Online sleep', 4: 'Ultra sleep' },
  },
  205: { label: 'GSM cell ID', group: 'network' },
  206: { label: 'GSM area code', group: 'network' },

  239: { label: 'Ignition', group: 'engine', states: ON_OFF },
  240: { label: 'Movement', group: 'movement', states: { 0: 'Stopped', 1: 'Moving' } },
  241: { label: 'GSM operator', group: 'network' },
  449: { label: 'Ignition on counter', group: 'engine' },

  389: { label: 'OEM total mileage', group: 'movement', unit: 'km' },
  390: { label: 'OEM fuel level', group: 'fuel', unit: 'L', scale: 100, precision: 2 },
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
    group: def.group,
    raw,
    value,
    unit: def.unit ?? null,
    display: def.unit ? `${value} ${def.unit}` : String(value),
    known: true,
  };
}
