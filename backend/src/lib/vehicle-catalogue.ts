// Make / model / year specifications for the vehicles Nigerian fleets actually run.
//
// Why this exists: a new vehicle used to be seeded from its *class* — every SUV
// and pickup alike started at 14.3 L/100 km. A RAV4 and a Land Cruiser are both
// "SUV" and are nowhere near each other, so the first weeks of estimates for a
// new vehicle were wrong by a wide margin in a direction nobody could predict.
// Seeding from the actual model closes most of that gap on day one, before a
// single receipt has been logged.
//
// **These are still seeds, not truth.** Every figure here is a real-world
// city-traffic equivalent for a well-maintained example, and a specific vehicle
// will differ by its age, engine option, load and condition. Fill-to-fill
// calibration replaces them with a measured rate as soon as there is one — see
// `fuel-calibration.ts`. The catalogue's job is to make the first estimate
// defensible, not final.
//
// Figures are deliberately *city-biased* rather than combined-cycle
// manufacturer ratings, which are measured on a test loop no Lagos fleet will
// ever reproduce. A combined-cycle number seeded here would flatter every
// vehicle and make the first calibration look like a regression.

import { VehicleType } from './fuel-metrics';

export interface VehicleModelSpec {
  model: string;
  /** Drives the class preset fallback and the body-class 3D illustration. */
  type: VehicleType;
  /** Litres. Manufacturer figure — a manager can override per vehicle. */
  tankLiters: number;
  /** L/100 km in mixed city traffic, not a combined-cycle rating. */
  consumptionL100km: number;
  /** L/h with the engine running and the vehicle stationary, AC on. */
  idleBurnLph: number;
  /** Generation range this spec applies to, inclusive. */
  years: [number, number];
  /** Set when a variant differs enough that one figure would mislead. */
  note?: string;
}

export interface VehicleMakeEntry {
  make: string;
  models: VehicleModelSpec[];
}

/**
 * Weighted to what actually runs in Nigerian fleets: Hiace and Sprinter buses,
 * Hilux and Navara pickups, Corolla and Camry saloons, and the Chinese and
 * Japanese trucks that do the heavy work. Anything absent falls back to
 * free-text entry plus a class preset, which is the old behaviour.
 */
export const VEHICLE_CATALOGUE: VehicleMakeEntry[] = [
  {
    make: 'Toyota',
    models: [
      { model: 'Hiace', type: 'van_bus', tankLiters: 70, consumptionL100km: 13.5, idleBurnLph: 1.3, years: [2005, 2026] },
      { model: 'Hilux', type: 'suv_pickup', tankLiters: 80, consumptionL100km: 12.8, idleBurnLph: 1.2, years: [2005, 2026] },
      { model: 'Corolla', type: 'sedan', tankLiters: 50, consumptionL100km: 9.0, idleBurnLph: 0.8, years: [2003, 2026] },
      { model: 'Camry', type: 'sedan', tankLiters: 60, consumptionL100km: 10.5, idleBurnLph: 0.9, years: [2002, 2026] },
      { model: 'RAV4', type: 'suv_pickup', tankLiters: 60, consumptionL100km: 11.8, idleBurnLph: 1.1, years: [2006, 2026] },
      { model: 'Land Cruiser', type: 'suv_pickup', tankLiters: 93, consumptionL100km: 18.5, idleBurnLph: 1.6, years: [2003, 2026] },
      { model: 'Prado', type: 'suv_pickup', tankLiters: 87, consumptionL100km: 16.0, idleBurnLph: 1.4, years: [2003, 2026] },
      { model: 'Highlander', type: 'suv_pickup', tankLiters: 72, consumptionL100km: 13.0, idleBurnLph: 1.2, years: [2004, 2026] },
      { model: 'Sienna', type: 'van_bus', tankLiters: 75, consumptionL100km: 13.0, idleBurnLph: 1.2, years: [2004, 2026] },
      { model: 'Coaster', type: 'van_bus', tankLiters: 95, consumptionL100km: 19.0, idleBurnLph: 1.8, years: [2000, 2026] },
      { model: 'Dyna', type: 'medium_truck', tankLiters: 100, consumptionL100km: 24.0, idleBurnLph: 1.9, years: [2000, 2026] },
    ],
  },
  {
    make: 'Kia',
    models: [
      { model: 'Rio', type: 'sedan', tankLiters: 45, consumptionL100km: 8.5, idleBurnLph: 0.7, years: [2005, 2026] },
      { model: 'Cerato', type: 'sedan', tankLiters: 50, consumptionL100km: 9.5, idleBurnLph: 0.8, years: [2005, 2026] },
      { model: 'Optima', type: 'sedan', tankLiters: 70, consumptionL100km: 10.8, idleBurnLph: 0.9, years: [2006, 2026] },
      { model: 'Sportage', type: 'suv_pickup', tankLiters: 58, consumptionL100km: 11.5, idleBurnLph: 1.1, years: [2005, 2026] },
      { model: 'Sorento', type: 'suv_pickup', tankLiters: 71, consumptionL100km: 13.5, idleBurnLph: 1.2, years: [2004, 2026] },
      { model: 'Picanto', type: 'sedan', tankLiters: 35, consumptionL100km: 7.5, idleBurnLph: 0.6, years: [2005, 2026] },
    ],
  },
  {
    make: 'Hyundai',
    models: [
      { model: 'Elantra', type: 'sedan', tankLiters: 50, consumptionL100km: 9.2, idleBurnLph: 0.8, years: [2004, 2026] },
      { model: 'Accent', type: 'sedan', tankLiters: 43, consumptionL100km: 8.5, idleBurnLph: 0.7, years: [2004, 2026] },
      { model: 'Sonata', type: 'sedan', tankLiters: 70, consumptionL100km: 10.8, idleBurnLph: 0.9, years: [2004, 2026] },
      { model: 'Tucson', type: 'suv_pickup', tankLiters: 58, consumptionL100km: 11.5, idleBurnLph: 1.1, years: [2005, 2026] },
      { model: 'Santa Fe', type: 'suv_pickup', tankLiters: 71, consumptionL100km: 13.2, idleBurnLph: 1.2, years: [2004, 2026] },
      { model: 'H-1 / Starex', type: 'van_bus', tankLiters: 75, consumptionL100km: 14.0, idleBurnLph: 1.3, years: [2005, 2026] },
    ],
  },
  {
    make: 'Mercedes-Benz',
    models: [
      { model: 'Sprinter', type: 'van_bus', tankLiters: 75, consumptionL100km: 14.5, idleBurnLph: 1.4, years: [2000, 2026] },
      { model: 'Vito', type: 'van_bus', tankLiters: 70, consumptionL100km: 12.5, idleBurnLph: 1.2, years: [2003, 2026] },
      { model: 'Actros', type: 'heavy_truck', tankLiters: 400, consumptionL100km: 38.0, idleBurnLph: 2.8, years: [2000, 2026] },
      { model: 'C-Class', type: 'sedan', tankLiters: 66, consumptionL100km: 11.0, idleBurnLph: 0.9, years: [2003, 2026] },
      { model: 'E-Class', type: 'sedan', tankLiters: 66, consumptionL100km: 11.8, idleBurnLph: 1.0, years: [2003, 2026] },
    ],
  },
  {
    make: 'Ford',
    models: [
      { model: 'Transit', type: 'van_bus', tankLiters: 80, consumptionL100km: 14.0, idleBurnLph: 1.3, years: [2003, 2026] },
      { model: 'Ranger', type: 'suv_pickup', tankLiters: 80, consumptionL100km: 12.5, idleBurnLph: 1.2, years: [2006, 2026] },
      { model: 'Explorer', type: 'suv_pickup', tankLiters: 70, consumptionL100km: 14.5, idleBurnLph: 1.3, years: [2004, 2026] },
      { model: 'Edge', type: 'suv_pickup', tankLiters: 68, consumptionL100km: 13.5, idleBurnLph: 1.2, years: [2007, 2026] },
    ],
  },
  {
    make: 'Nissan',
    models: [
      { model: 'Navara', type: 'suv_pickup', tankLiters: 80, consumptionL100km: 12.8, idleBurnLph: 1.2, years: [2005, 2026] },
      { model: 'Urvan', type: 'van_bus', tankLiters: 65, consumptionL100km: 13.8, idleBurnLph: 1.3, years: [2003, 2026] },
      { model: 'Almera', type: 'sedan', tankLiters: 41, consumptionL100km: 8.5, idleBurnLph: 0.7, years: [2004, 2026] },
      { model: 'X-Trail', type: 'suv_pickup', tankLiters: 60, consumptionL100km: 11.8, idleBurnLph: 1.1, years: [2004, 2026] },
      { model: 'Patrol', type: 'suv_pickup', tankLiters: 95, consumptionL100km: 18.0, idleBurnLph: 1.6, years: [2003, 2026] },
    ],
  },
  {
    make: 'Honda',
    models: [
      { model: 'Accord', type: 'sedan', tankLiters: 65, consumptionL100km: 10.5, idleBurnLph: 0.9, years: [2003, 2026] },
      { model: 'Civic', type: 'sedan', tankLiters: 47, consumptionL100km: 8.8, idleBurnLph: 0.8, years: [2003, 2026] },
      { model: 'CR-V', type: 'suv_pickup', tankLiters: 58, consumptionL100km: 11.5, idleBurnLph: 1.1, years: [2004, 2026] },
      { model: 'Pilot', type: 'suv_pickup', tankLiters: 74, consumptionL100km: 14.5, idleBurnLph: 1.3, years: [2005, 2026] },
    ],
  },
  {
    make: 'Mitsubishi',
    models: [
      { model: 'L200', type: 'suv_pickup', tankLiters: 75, consumptionL100km: 12.5, idleBurnLph: 1.2, years: [2005, 2026] },
      { model: 'Pajero', type: 'suv_pickup', tankLiters: 88, consumptionL100km: 16.0, idleBurnLph: 1.4, years: [2003, 2026] },
      { model: 'Canter', type: 'medium_truck', tankLiters: 100, consumptionL100km: 23.0, idleBurnLph: 1.9, years: [2000, 2026] },
    ],
  },
  {
    make: 'Isuzu',
    models: [
      { model: 'D-Max', type: 'suv_pickup', tankLiters: 76, consumptionL100km: 12.0, idleBurnLph: 1.2, years: [2005, 2026] },
      { model: 'NPR', type: 'medium_truck', tankLiters: 100, consumptionL100km: 24.0, idleBurnLph: 1.9, years: [2000, 2026] },
      { model: 'FVR', type: 'heavy_truck', tankLiters: 200, consumptionL100km: 34.0, idleBurnLph: 2.5, years: [2000, 2026] },
    ],
  },
  {
    make: 'Volkswagen',
    models: [
      { model: 'Golf', type: 'sedan', tankLiters: 55, consumptionL100km: 9.0, idleBurnLph: 0.8, years: [2003, 2026] },
      { model: 'Passat', type: 'sedan', tankLiters: 70, consumptionL100km: 10.5, idleBurnLph: 0.9, years: [2003, 2026] },
      { model: 'Crafter', type: 'van_bus', tankLiters: 75, consumptionL100km: 14.5, idleBurnLph: 1.4, years: [2006, 2026] },
      { model: 'Amarok', type: 'suv_pickup', tankLiters: 80, consumptionL100km: 12.8, idleBurnLph: 1.2, years: [2010, 2026] },
    ],
  },
  {
    make: 'JAC',
    models: [
      { model: 'X200 Pickup', type: 'suv_pickup', tankLiters: 70, consumptionL100km: 13.0, idleBurnLph: 1.2, years: [2012, 2026] },
      { model: 'N-Series Truck', type: 'medium_truck', tankLiters: 120, consumptionL100km: 25.0, idleBurnLph: 1.9, years: [2012, 2026] },
      { model: 'Sunray Bus', type: 'van_bus', tankLiters: 90, consumptionL100km: 16.0, idleBurnLph: 1.5, years: [2014, 2026] },
    ],
  },
  {
    make: 'Iveco',
    models: [
      { model: 'Daily', type: 'van_bus', tankLiters: 90, consumptionL100km: 15.5, idleBurnLph: 1.5, years: [2003, 2026] },
      { model: 'Eurocargo', type: 'heavy_truck', tankLiters: 200, consumptionL100km: 32.0, idleBurnLph: 2.4, years: [2003, 2026] },
    ],
  },
  {
    make: 'Mack',
    models: [
      { model: 'Granite', type: 'heavy_truck', tankLiters: 400, consumptionL100km: 42.0, idleBurnLph: 3.0, years: [2000, 2026] },
      { model: 'CH / Vision', type: 'heavy_truck', tankLiters: 380, consumptionL100km: 40.0, idleBurnLph: 2.8, years: [1998, 2020] },
    ],
  },
];

/** Oldest year any catalogue entry covers — the floor for the year dropdown. */
export const CATALOGUE_MIN_YEAR = 1998;

export interface ResolvedVehicleSpec {
  make: string;
  model: string;
  year: number | null;
  type: VehicleType;
  tankLiters: number;
  consumptionL100km: number;
  idleBurnLph: number;
  /** True when this came from the catalogue rather than a class fallback. */
  matched: boolean;
  note?: string;
}

const norm = (value: string): string => value.trim().toLowerCase();

/** Every make in the catalogue, for the first dropdown. */
export function catalogueMakes(): string[] {
  return VEHICLE_CATALOGUE.map((m) => m.make);
}

/** Models offered for a make, narrowed to those sold in the chosen year. */
export function catalogueModels(make: string, year?: number | null): VehicleModelSpec[] {
  const entry = VEHICLE_CATALOGUE.find((m) => norm(m.make) === norm(make));
  if (!entry) return [];
  if (year == null) return entry.models;
  return entry.models.filter((spec) => year >= spec.years[0] && year <= spec.years[1]);
}

/** Years a given model was available, for the year dropdown. */
export function catalogueYears(make: string, model: string): number[] {
  const spec = findSpec(make, model);
  if (!spec) return [];
  const [from, to] = spec.years;
  const cap = Math.min(to, new Date().getFullYear() + 1);
  const years: number[] = [];
  for (let y = cap; y >= from; y -= 1) years.push(y);
  return years;
}

function findSpec(make: string, model: string): VehicleModelSpec | null {
  const entry = VEHICLE_CATALOGUE.find((m) => norm(m.make) === norm(make));
  if (!entry) return null;
  return entry.models.find((s) => norm(s.model) === norm(model)) ?? null;
}

/**
 * The starting figures for a vehicle.
 *
 * Returns `matched: false` when the make/model is not in the catalogue, so the
 * caller can say "we are using a class average for this one" rather than
 * implying the numbers are specific to the vehicle. A fleet running something
 * unusual is not blocked — it just starts less accurate and calibrates its way
 * out like everything else.
 */
export function resolveVehicleSpec(
  make: string | null | undefined,
  model: string | null | undefined,
  year: number | null | undefined,
  fallback: { type: VehicleType; consumptionL100km: number; idleBurnLph: number }
): ResolvedVehicleSpec {
  const spec = make && model ? findSpec(make, model) : null;

  if (!spec) {
    return {
      make: make ?? '',
      model: model ?? '',
      year: year ?? null,
      type: fallback.type,
      // No catalogue tank size to offer; the caller keeps whatever the manager
      // typed rather than having a number invented for it.
      tankLiters: 0,
      consumptionL100km: fallback.consumptionL100km,
      idleBurnLph: fallback.idleBurnLph,
      matched: false,
    };
  }

  return {
    make: make!,
    model: spec.model,
    year: year ?? null,
    type: spec.type,
    tankLiters: spec.tankLiters,
    consumptionL100km: spec.consumptionL100km,
    idleBurnLph: spec.idleBurnLph,
    matched: true,
    note: spec.note,
  };
}
