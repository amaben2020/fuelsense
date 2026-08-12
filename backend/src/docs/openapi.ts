// The FuelSense HTTP API, described once so it cannot drift into folklore.
//
// This is written by hand rather than generated from decorators. The endpoints
// here carry a lot of meaning that no generator could recover — which figures
// are measured and which are modelled, when a field is null because the fleet
// has not configured something, why a window is a calendar day rather than a
// rolling one. Those notes are the reason the file exists; the paths and status
// codes are the easy part.
//
// Conventions that hold everywhere unless a path says otherwise:
//   * every route except /auth/register, /auth/login, /driver/login and
//     /contact requires a bearer JWT
//   * the customer is taken from the token, never from a parameter, so no
//     endpoint accepts a customer id
//   * `days` counts calendar days in Africa/Lagos, including today — 1 means
//     since midnight this morning, not the last 24 hours
//   * money is whole naira; litres and kilometres are decimal
//   * a null money field means the fleet has recorded no fuel price, and the
//     caller should show quantities without a value rather than assuming one

const bearer = [{ bearerAuth: [] }];
const driverBearer = [{ driverAuth: [] }];

/** `days` query parameter, with the calendar-day semantics spelled out. */
const daysParam = (max = 90, def = 7) => ({
  name: 'days',
  in: 'query' as const,
  required: false,
  schema: { type: 'integer' as const, minimum: 1, maximum: max, default: def },
  description:
    `Calendar days in Africa/Lagos, counting today. 1 = since local midnight. Capped at ${max}.`,
});

const vehicleIdParam = {
  name: 'id',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const, format: 'uuid' },
  description: 'Vehicle id. Must belong to the authenticated customer.',
};

/** A plain JSON object response with a description. */
const ok = (description: string, schema: object = { type: 'object' }) => ({
  '200': { description, content: { 'application/json': { schema } } },
});

const errors = {
  '400': { description: 'Request was malformed or a value was out of range.' },
  '401': { description: 'Missing, expired or rejected bearer token.' },
  '404': { description: 'Not found, or not owned by the authenticated customer.' },
  '500': { description: 'Unhandled server error.' },
};

const arrayOf = (ref: string) => ({ type: 'array', items: { $ref: `#/components/schemas/${ref}` } });

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'FuelSense API',
    version: '1.0.0',
    description: [
      'Fleet fuel intelligence for vehicles fitted with Teltonika trackers.',
      '',
      '## What this API can and cannot tell you',
      '',
      'The trackers this platform is built around report GPS position, speed,',
      'heading, ignition and an odometer. They carry **no CAN or OBD link and no',
      'fuel-level sensor**, so no endpoint returns a sensed fuel level, engine',
      'RPM, coolant temperature or engine load — those fields do not exist here',
      'rather than being returned as zero.',
      '',
      'Fuel level and consumption are **modelled**: distance is charged at the',
      "rate configured on the vehicle, plus idle time at that vehicle's idle",
      'rate. Fields documented as modelled must not be presented to an end user',
      'as measurements. Distance, speed, position and ignition state *are*',
      'measured, and distance is validated against the odometer.',
      '',
      'Harsh braking, acceleration and cornering are **derived** from the speed',
      'and heading series rather than reported by the device, whose Green',
      'Driving scenario is typically disabled. Overspeeding is derived from',
      'measured speed against a limit the fleet declares per vehicle; with no',
      'limit set, no overspeeding is reported.',
      '',
      '## Money',
      '',
      'Every naira figure is derived from a price per litre. Prices are',
      'effective-dated: a period is valued at the benchmark price that was in',
      'force at the time, falling back to the newest receipt. When neither',
      'exists the money field is `null` — never a default constant.',
    ].join('\n'),
    contact: { name: 'FuelSense' },
  },
  servers: [
    { url: '/api', description: 'Same-origin API root' },
    { url: 'http://localhost:5001/api', description: 'Local development' },
  ],
  tags: [
    { name: 'Auth', description: 'Fleet-manager accounts and session tokens.' },
    { name: 'Vehicles', description: 'Fleet roster, per-vehicle rates and limits.' },
    { name: 'Devices', description: 'Teltonika trackers and their pairing to vehicles.' },
    { name: 'Telemetry', description: 'Readings, trips, activity and efficiency.' },
    { name: 'Dashboard', description: 'Aggregates for the manager overview.' },
    { name: 'Fuel events', description: 'Anomalies, siphon events and receipt replays.' },
    { name: 'Fuel price', description: 'Effective-dated benchmark prices.' },
    { name: 'Driving events', description: 'Harsh manoeuvres and overspeeding.' },
    { name: 'Drivers', description: 'Driver records, assignment and reports.' },
    { name: 'Driver portal', description: 'The driver-facing app. Separate token.' },
    { name: 'Alerts', description: 'Open alerts and acknowledgement.' },
    { name: 'Geofences', description: 'Zones and entry/exit events.' },
    { name: 'Maintenance', description: 'Scheduled and completed servicing.' },
    { name: 'Intelligence', description: 'Security, working hours and utilisation.' },
    { name: 'Orders', description: 'Tracker hardware orders.' },
    { name: 'Places', description: 'Proxied Google Places and imagery.' },
    { name: 'Features', description: 'Feature flags, config and notification prefs.' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Fleet-manager token from `POST /auth/login`.',
      },
      driverAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Driver token from `POST /driver/login`. Scoped to one driver and not interchangeable with a manager token.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      Customer: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          company_name: { type: 'string', nullable: true },
          logo_url: { type: 'string', nullable: true, description: 'White-label mark.' },
          brand_color: { type: 'string', nullable: true },
          subscription_status: { type: 'string' },
          onboarding_completed: { type: 'boolean' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Bearer JWT.' },
          customer: { $ref: '#/components/schemas/Customer' },
        },
      },
      FleetVehicle: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          license_plate: { type: 'string' },
          make: { type: 'string', nullable: true },
          model: { type: 'string', nullable: true },
          year: { type: 'integer', nullable: true },
          tank_capacity_liters: { type: 'integer', nullable: true },
          driver_name: { type: 'string', nullable: true },
          imei: { type: 'string', nullable: true },
          last_seen_at: { type: 'string', format: 'date-time', nullable: true },
          fuel_level_liters: {
            type: 'number',
            nullable: true,
            description:
              'MODELLED tank level, not a sensor reading. Charged from distance and idle time.',
          },
          odometer_km: {
            type: 'number',
            nullable: true,
            description: 'Distance the tracker has counted since it was fitted (AVL 16).',
          },
          total_odometer_km: {
            type: 'number',
            nullable: true,
            description:
              'True vehicle mileage. Null until a dashboard baseline is anchored via POST /vehicles/{id}/odometer.',
          },
          speed_limit_kph: {
            type: 'integer',
            nullable: true,
            description:
              'Speed above which this vehicle is overspeeding. Null means the fleet has declared none and no overspeeding is reported.',
          },
        },
      },
      TelemetryReading: {
        type: 'object',
        properties: {
          recorded_at: { type: 'string', format: 'date-time' },
          latitude: { type: 'number', nullable: true },
          longitude: { type: 'number', nullable: true },
          speed_kph: { type: 'number', description: 'Measured GNSS speed.' },
          ignition_on: { type: 'boolean' },
          odometer_km: { type: 'number', nullable: true },
          fuel_level_liters: {
            type: 'number',
            nullable: true,
            description: 'MODELLED level. See the API description.',
          },
        },
      },
      EventReplay: {
        type: 'object',
        description:
          'Everything needed to replay one flagged moment: the readings either side of it, the manoeuvres inside the window, and the reasoning behind the flag.',
        properties: {
          event_type: {
            type: 'string',
            enum: [
              'siphon',
              'receipt_fraud',
              'daily_flag',
              'data_anomaly',
              'low_efficiency',
              'harsh_braking',
              'harsh_acceleration',
              'harsh_cornering',
              'overspeeding',
            ],
          },
          vehicle_plate: { type: 'string' },
          driver_name: { type: 'string', nullable: true },
          range_start: { type: 'string', format: 'date-time' },
          range_end: { type: 'string', format: 'date-time' },
          anomaly_at: { type: 'string', format: 'date-time' },
          anomaly_index: { type: 'integer', description: 'Index into `readings`.' },
          readings: arrayOf('TelemetryReading'),
          manoeuvres: {
            ...arrayOf('TrackManoeuvre'),
            description:
              'Harsh manoeuvres inside the window, derived from the GPS speed and heading series.',
          },
          speed_limit_kph: {
            type: 'integer',
            nullable: true,
            description:
              'The declared limit, so a client can shade overspeed stretches from the plotted speeds.',
          },
          anomaly: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              liters_lost: { type: 'number' },
              estimated_loss_ngn: {
                type: 'integer',
                nullable: true,
                description:
                  'Valued at the price in force when the loss occurred. Null when the fleet has recorded no price.',
              },
              price_ngn_per_liter: { type: 'number', nullable: true },
              price_source: {
                type: 'string',
                nullable: true,
                enum: ['benchmark', 'receipt', null],
              },
              confidence_percent: { type: 'integer' },
              reasons: { type: 'array', items: { type: 'string' } },
              why_flagged: { type: 'array', items: { type: 'string' } },
              confidence_factors: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Only facts checkable against the readings in the window. Never a fixed list.',
              },
              recommended_actions: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      TrackManoeuvre: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['harsh_braking', 'harsh_acceleration', 'harsh_cornering', 'overspeeding'],
          },
          occurred_at: { type: 'string', format: 'date-time' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
          magnitude_ms2: {
            type: 'number',
            nullable: true,
            description: 'm/s² for harsh manoeuvres; peak km/h for overspeeding.',
          },
          speed_kph: { type: 'integer', nullable: true },
          index: { type: 'integer', description: 'Nearest entry in `readings`.' },
        },
      },
      BenchmarkPrice: {
        type: 'object',
        properties: {
          ngn_per_liter: { type: 'number' },
          effective_from: { type: 'string', format: 'date-time' },
          source: { type: 'string' },
          note: { type: 'string', nullable: true },
        },
      },
    },
  },
  security: bearer,
  paths: {
    // ---------------------------------------------------------------- auth
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create a fleet-manager account',
        description: 'Rate limited. Returns a token, so no separate login is needed after signup.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  company_name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          ...ok('Account created.', { $ref: '#/components/schemas/AuthResponse' }),
          '400': { description: 'Email already registered, or a field failed validation.' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a bearer token',
        description: 'Rate limited to blunt credential stuffing.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          ...ok('Signed in.', { $ref: '#/components/schemas/AuthResponse' }),
          '401': { description: 'Email or password rejected.' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'The account behind the current token',
        security: bearer,
        responses: {
          ...ok('The signed-in customer.', { $ref: '#/components/schemas/Customer' }),
          '401': errors['401'],
        },
      },
    },
    '/auth/branding': {
      patch: {
        tags: ['Auth'],
        summary: 'Set white-label logo and brand colour',
        security: bearer,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  logo_url: { type: 'string', nullable: true },
                  brand_color: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: { ...ok('Branding updated.'), ...errors },
      },
    },
    '/auth/onboarding': {
      patch: {
        tags: ['Auth'],
        summary: 'Mark onboarding complete',
        description: 'Controls whether the landing page redirects to /dashboard or /onboarding.',
        security: bearer,
        responses: { ...ok('Flag updated.'), ...errors },
      },
    },

    // ------------------------------------------------------------ vehicles
    '/vehicles/fleet': {
      get: {
        tags: ['Vehicles'],
        summary: 'Every vehicle with its live state',
        description:
          'The roster plus last-seen, modelled tank level, odometer and declared speed limit. This is the payload the fleet map and vehicle list are built from.',
        responses: { ...ok('Fleet roster.', arrayOf('FleetVehicle')), ...errors },
      },
    },
    '/vehicles': {
      get: {
        tags: ['Vehicles'],
        summary: 'Vehicle records without live telemetry',
        responses: { ...ok('Vehicles.', arrayOf('FleetVehicle')), ...errors },
      },
      post: {
        tags: ['Vehicles'],
        summary: 'Add a vehicle',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['license_plate'],
                properties: {
                  license_plate: { type: 'string' },
                  make: { type: 'string' },
                  model: { type: 'string' },
                  year: { type: 'integer' },
                  tank_capacity_liters: { type: 'integer' },
                  vehicle_type: {
                    type: 'string',
                    description:
                      'Seeds the consumption and idle rates from a class preset until calibrated.',
                  },
                },
              },
            },
          },
        },
        responses: { ...ok('Vehicle created.'), ...errors },
      },
    },
    '/vehicles/with-device': {
      post: {
        tags: ['Vehicles'],
        summary: 'Add a vehicle and pair a tracker in one step',
        description: 'Avoids the window where a vehicle exists with no device and reports nothing.',
        responses: { ...ok('Vehicle and device created.'), ...errors },
      },
    },
    '/vehicles/bulk': {
      post: {
        tags: ['Vehicles'],
        summary: 'Create several vehicles at once',
        responses: { ...ok('Vehicles created, with per-row outcomes.'), ...errors },
      },
    },
    '/vehicles/{id}/virtual-tank': {
      get: {
        tags: ['Vehicles'],
        summary: 'Modelled tank state for one vehicle',
        description:
          'The level here is inferred from distance and idle time, never sensed. Includes the anchor it was last calibrated from.',
        parameters: [vehicleIdParam],
        responses: { ...ok('Tank state.'), ...errors },
      },
    },
    '/vehicles/{id}/virtual-tank/calibrate': {
      post: {
        tags: ['Vehicles'],
        summary: 'Re-anchor the modelled tank to a known level',
        description:
          'Writes a marker row so the step change is not later counted as consumption or as a siphon. Do this **after** the Configurator profile is set, not before.',
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['liters'],
                properties: { liters: { type: 'number', minimum: 0 } },
              },
            },
          },
        },
        responses: { ...ok('Tank re-anchored.'), ...errors },
      },
    },
    '/vehicles/{id}/economy': {
      post: {
        tags: ['Vehicles'],
        summary: "Set the vehicle's fuel economy from its own trip computer",
        description:
          'The unit is required rather than assumed: 15 mpg is 6.38 km/L on a US gallon and 5.31 on an imperial one, a 20% gap in the figure the whole fuel model rests on. Send `null` to fall back to the class preset.',
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                nullable: true,
                required: ['value', 'unit'],
                properties: {
                  value: { type: 'number', exclusiveMinimum: 0 },
                  unit: { type: 'string', enum: ['mpg_us', 'mpg_imp', 'km_l', 'l_100km'] },
                },
              },
            },
          },
        },
        responses: { ...ok('Economy stored, echoed in km/L and L/100 km.'), ...errors },
      },
    },
    '/vehicles/{id}/odometer': {
      post: {
        tags: ['Vehicles'],
        summary: "Anchor true mileage to the dashboard reading",
        description:
          'The tracker only counts distance since it was fitted, so real total mileage is this baseline plus whatever the device has counted since the anchor instant.',
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['odometerKm'],
                properties: { odometerKm: { type: 'number', minimum: 0 } },
              },
            },
          },
        },
        responses: { ...ok('Baseline anchored.'), ...errors },
      },
    },
    '/vehicles/{id}/speed-limit': {
      post: {
        tags: ['Vehicles', 'Driving events'],
        summary: 'Declare the speed above which this vehicle is overspeeding',
        description: [
          'Set this to match the limit configured on the tracker.',
          '',
          'It is stored here rather than read from the device because the tracker',
          'only emits an overspeed event when its Overspeeding *scenario* is',
          'switched on — a limit typed into the Configurator without that switch',
          'produces nothing — and a device-side event can never be recomputed for',
          'a drive that already happened. With the limit stored, overspeeding is',
          'derived from the GPS speed already recorded on every fix, including',
          'retrospectively.',
          '',
          'Send `null` to clear it. No overspeeding is then reported for the',
          'vehicle; the platform will not choose a limit on your behalf.',
        ].join('\n'),
        parameters: [vehicleIdParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  speedLimitKph: {
                    type: 'integer',
                    nullable: true,
                    minimum: 20,
                    maximum: 200,
                    example: 100,
                  },
                },
              },
            },
          },
        },
        responses: {
          ...ok('Limit stored.', {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              speed_limit_kph: { type: 'integer', nullable: true },
            },
          }),
          ...errors,
          '400': { description: 'Limit outside 20–200 km/h and not null.' },
        },
      },
    },

    // ------------------------------------------------------------- devices
    '/devices': {
      get: {
        tags: ['Devices'],
        summary: 'Registered trackers',
        responses: { ...ok('Devices.'), ...errors },
      },
      post: {
        tags: ['Devices'],
        summary: 'Register a tracker by IMEI and pair it to a vehicle',
        description:
          'Until an IMEI is registered the TCP server accepts its frames but cannot attribute them to a fleet.',
        responses: { ...ok('Device registered.'), ...errors },
      },
    },

    // ----------------------------------------------------------- telemetry
    '/telemetry/latest': {
      get: {
        tags: ['Telemetry'],
        summary: 'Most recent reading per vehicle',
        responses: { ...ok('Latest readings.', arrayOf('TelemetryReading')), ...errors },
      },
    },
    '/telemetry/history': {
      get: {
        tags: ['Telemetry'],
        summary: 'Raw readings for one vehicle over a window',
        parameters: [
          { name: 'vehicleId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          daysParam(90, 7),
        ],
        responses: { ...ok('Readings.', arrayOf('TelemetryReading')), ...errors },
      },
    },
    '/telemetry/tracks': {
      get: {
        tags: ['Telemetry'],
        summary: 'Recent position trails for the fleet map',
        parameters: [
          {
            name: 'minutes',
            in: 'query',
            schema: { type: 'integer', default: 120 },
            description: 'Length of the trail behind each vehicle.',
          },
        ],
        responses: { ...ok('Trails per vehicle.'), ...errors },
      },
    },
    '/telemetry/trips': {
      get: {
        tags: ['Telemetry'],
        summary: 'Segmented trips with paths, stops and idle stretches',
        description: [
          'A trip opens on an ignition edge and closes after a rest period. Distance',
          'is odometer-validated with GPS jitter and impossible hops rejected.',
          '',
          'Fuel and cost per trip are modelled, and `estimated_cost_ngn` is null',
          'until a fuel price exists.',
        ].join('\n'),
        parameters: [
          { name: 'minutes', in: 'query', schema: { type: 'integer' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          {
            name: 'fallback',
            in: 'query',
            schema: { type: 'string', enum: ['1'] },
            description:
              'Opt in to the most recent historical trips when the live window is empty, rather than returning nothing.',
          },
        ],
        responses: { ...ok('Trips grouped by vehicle.'), ...errors },
      },
    },
    '/telemetry/stop-place': {
      get: {
        tags: ['Telemetry'],
        summary: 'Resolve a stop coordinate to a named place',
        description: 'Cached, because place lookups are billed per call.',
        responses: { ...ok('Place name and address, or nulls when never geocoded.'), ...errors },
      },
    },
    '/telemetry/consumption-trend/{vehicleId}': {
      get: {
        tags: ['Telemetry'],
        summary: 'Modelled consumption over time for one vehicle',
        parameters: [
          { name: 'vehicleId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          daysParam(90, 30),
        ],
        responses: { ...ok('Trend points.'), ...errors },
      },
    },
    '/telemetry/purchase-reconciliation': {
      get: {
        tags: ['Telemetry'],
        summary: 'Receipts matched against modelled tank rises',
        description:
          'A mismatch is an invitation to investigate, not proof of fraud — the comparison is against a modelled level, not a sensor.',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Reconciliation rows.'), ...errors },
      },
    },
    '/telemetry/fleet-efficiency': {
      get: {
        tags: ['Telemetry'],
        summary: 'Per-vehicle distance, modelled burn, cost and benchmark variance',
        description: [
          'Ratios are withheld (returned null) when too little of the fuel a',
          'distance should have burned is present, rather than publishing a',
          'flattering number with nothing behind it.',
          '',
          'Costs use the benchmark price in force for each period, falling back to',
          'the newest receipt.',
        ].join('\n'),
        parameters: [daysParam(90, 7)],
        responses: { ...ok('Rows plus a fleet summary.'), ...errors },
      },
    },
    '/telemetry/daily-activity': {
      get: {
        tags: ['Telemetry'],
        summary: 'One row per vehicle per local day',
        description:
          'Distance, modelled fuel, idle hours, trip count and an efficiency status. Days are Africa/Lagos calendar days.',
        parameters: [
          daysParam(90, 30),
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
        ],
        responses: { ...ok('Paginated activity rows.'), ...errors },
      },
    },
    '/telemetry/daily-activity/replay': {
      get: {
        tags: ['Telemetry', 'Driving events'],
        summary: 'Replay the telemetry behind a daily flag',
        description: [
          'Returns the readings around a flagged moment together with the harsh',
          'manoeuvres inside the window and the vehicle’s declared speed limit.',
          '',
          'Pass `focusAt` for a manoeuvre: a harsh brake is a second, not a day,',
          'and without it the window is the whole day and the caption would point',
          'at the wrong moment.',
        ].join('\n'),
        parameters: [
          { name: 'vehicleId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          {
            name: 'flagType',
            in: 'query',
            schema: {
              type: 'string',
              enum: [
                'harsh_braking',
                'harsh_acceleration',
                'harsh_cornering',
                'overspeeding',
                'data_anomaly',
                'low_efficiency',
              ],
            },
          },
          {
            name: 'focusAt',
            in: 'query',
            schema: { type: 'string', format: 'date-time' },
            description: 'Centre the window on this instant, ±5 minutes.',
          },
        ],
        responses: {
          ...ok('Replay payload.', { $ref: '#/components/schemas/EventReplay' }),
          ...errors,
        },
      },
    },
    '/telemetry/fuel-purchases': {
      get: {
        tags: ['Telemetry'],
        summary: 'Logged fuel purchases',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Purchases with totals.'), ...errors },
      },
    },
    '/telemetry/fuel-purchases/receipt': {
      post: {
        tags: ['Telemetry'],
        summary: 'Log a purchase from a receipt',
        description: 'Receipts are the authority on actual spend and on price per litre.',
        responses: { ...ok('Purchase recorded.'), ...errors },
      },
    },
    '/telemetry/readings': {
      get: {
        tags: ['Telemetry'],
        summary: 'Paginated raw readings across the fleet',
        responses: { ...ok('Readings.'), ...errors },
      },
    },
    '/telemetry/efficiency': {
      get: {
        tags: ['Telemetry'],
        summary: 'Daily averaged odometer and modelled fuel level',
        parameters: [daysParam(90, 7)],
        responses: { ...ok('Daily averages.'), ...errors },
      },
    },
    '/telemetry/vehicle-signals': {
      get: {
        tags: ['Telemetry'],
        summary: 'Every AVL element the device actually sent, decoded',
        description: [
          'Frame-driven rather than column-driven: each key present in the raw',
          'frame is decoded through the AVL catalogue with its label, unit and',
          'scaling. Enabling a new element in the Teltonika Configurator therefore',
          'surfaces it here with no backend change.',
          '',
          'The reference fleet transmits 15 elements and no CAN/OBD group at all,',
          'so absence here means the device is not sending it.',
        ].join('\n'),
        parameters: [
          { name: 'vehicleId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Decoded signals.'), ...errors },
      },
    },
    '/telemetry/google-usage': {
      get: {
        tags: ['Telemetry'],
        summary: 'Billed Google Maps/Places call counts',
        responses: { ...ok('Usage counters.'), ...errors },
      },
    },

    // ----------------------------------------------------------- dashboard
    '/dashboard/summary': {
      get: {
        tags: ['Dashboard'],
        summary: 'Headline fleet counters',
        parameters: [daysParam(90, 7)],
        responses: { ...ok('Vehicle counts, alert counts and cost totals.'), ...errors },
      },
    },
    '/dashboard/utilisation': {
      get: {
        tags: ['Dashboard'],
        summary: 'Distance, idle hours and active days per vehicle',
        description: 'Active days are distinct local calendar days with real movement.',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Utilisation rows.'), ...errors },
      },
    },
    '/dashboard/estimated-consumption': {
      get: {
        tags: ['Dashboard'],
        summary: 'Modelled fuel and cost, per vehicle per day',
        description: [
          'Fuel = distance ÷ the rate configured on that vehicle + idle hours ×',
          "that vehicle's idle rate. Both come from the vehicle record, so a",
          'change on the calibration screen moves these figures immediately.',
          '',
          'Each day is valued at the fuel price in force **on that day**;',
          '`price_per_liter_ngn` in the response is the current rate, for captions',
          'only. It is null — and costs are zero — when the fleet has recorded',
          'neither a benchmark price nor a receipt.',
        ].join('\n'),
        parameters: [daysParam(90, 7)],
        responses: { ...ok('Per-day and per-vehicle estimates with totals.'), ...errors },
      },
    },

    // --------------------------------------------------------- fuel events
    '/fuel-events': {
      get: {
        tags: ['Fuel events'],
        summary: 'Siphon events and receipt mismatches',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Events.'), ...errors },
      },
    },
    '/fuel-events/siphon-events/{id}/replay': {
      get: {
        tags: ['Fuel events'],
        summary: 'Replay a suspected siphon',
        description:
          'Readings are only those actually recorded. A sparse window is reported as sparse rather than padded with synthetic points.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          ...ok('Replay payload.', { $ref: '#/components/schemas/EventReplay' }),
          ...errors,
        },
      },
    },
    '/fuel-events/receipts/{id}/replay': {
      get: {
        tags: ['Fuel events'],
        summary: 'Replay a receipt-versus-tank mismatch',
        description:
          "The shortfall is valued at the receipt's own price per litre when it has one, since that is what was actually paid.",
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          ...ok('Replay payload.', { $ref: '#/components/schemas/EventReplay' }),
          ...errors,
        },
      },
    },
    '/fuel-events/receipts/{id}/resolve': {
      patch: {
        tags: ['Fuel events'],
        summary: 'Close a receipt mismatch with an outcome',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Resolved.'), ...errors },
      },
    },

    // ---------------------------------------------------------- fuel price
    '/fuel-price': {
      get: {
        tags: ['Fuel price'],
        summary: 'Benchmark price history and the current rate',
        description:
          'Periods are effective-dated and never edited in place, so history keeps the price that actually applied.',
        responses: { ...ok('Price periods, newest first.', arrayOf('BenchmarkPrice')), ...errors },
      },
      post: {
        tags: ['Fuel price'],
        summary: 'Open a new price period',
        description:
          'Back-dating is allowed so a missed change can be recorded. Earlier periods are left untouched.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ngnPerLiter'],
                properties: {
                  ngnPerLiter: { type: 'number', exclusiveMinimum: 0, example: 1300 },
                  effectiveFrom: { type: 'string', format: 'date-time' },
                  note: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: { ...ok('Period opened.', { $ref: '#/components/schemas/BenchmarkPrice' }), ...errors },
      },
    },

    // ------------------------------------------------------ driving events
    '/device-events': {
      get: {
        tags: ['Driving events'],
        summary: 'Harsh manoeuvres, overspeeding and device scenario events',
        description: [
          'Harsh braking, acceleration and cornering are computed from the GPS',
          'speed and heading series — the tracker reports none of them unless its',
          'Green Driving scenario is enabled, and on the reference fleet it is not.',
          '',
          'Overspeeding rows may come from either the derived sweep or a',
          'device-emitted AVL 255; both carry the peak speed in `value`, and the',
          'sweep will not duplicate an event the device already reported.',
        ].join('\n'),
        parameters: [
          daysParam(90, 14),
          { name: 'vehicleId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
        ],
        responses: { ...ok('Events.'), ...errors },
      },
    },
    '/device-events/summary': {
      get: {
        tags: ['Driving events'],
        summary: 'Event counts and driver scores',
        parameters: [daysParam(90, 14)],
        responses: { ...ok('Counts by type, with per-driver scores.'), ...errors },
      },
    },

    // ------------------------------------------------------------- drivers
    '/drivers': {
      get: { tags: ['Drivers'], summary: 'Driver records', responses: { ...ok('Drivers.'), ...errors } },
      post: {
        tags: ['Drivers'],
        summary: 'Add a driver',
        responses: { ...ok('Driver created.'), ...errors },
      },
    },
    '/drivers/{id}/credentials': {
      patch: {
        tags: ['Drivers'],
        summary: 'Set or rotate a driver PIN',
        description: 'PINs are hashed. The plaintext is returned once, at creation, and never again.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Credentials updated.'), ...errors },
      },
    },
    '/drivers/assign': {
      patch: {
        tags: ['Drivers'],
        summary: 'Assign a driver to a vehicle',
        responses: { ...ok('Assignment updated.'), ...errors },
      },
    },
    '/drivers/reports': {
      get: {
        tags: ['Drivers'],
        summary: 'Per-driver monthly distance, modelled fuel and behaviour',
        description:
          'Expected fuel includes an idle allowance — comparing idle-inclusive burn against a driving-only benchmark flagged every driver who sat in traffic.',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Driver reports.'), ...errors },
      },
    },

    // ------------------------------------------------------- driver portal
    '/driver/login': {
      post: {
        tags: ['Driver portal'],
        summary: 'Driver sign-in with code and PIN',
        security: [],
        responses: { ...ok('Driver token.'), '401': errors['401'] },
      },
    },
    '/driver/me': {
      get: {
        tags: ['Driver portal'],
        summary: 'The signed-in driver',
        security: driverBearer,
        responses: { ...ok('Driver record.'), ...errors },
      },
    },
    '/driver/vehicle/status': {
      get: {
        tags: ['Driver portal'],
        summary: 'Assigned vehicle state',
        security: driverBearer,
        responses: { ...ok('Vehicle status.'), ...errors },
      },
    },
    '/driver/trips': {
      get: {
        tags: ['Driver portal'],
        summary: "The driver's own trips",
        security: driverBearer,
        responses: { ...ok('Trips.'), ...errors },
      },
    },
    '/driver/receipts': {
      get: {
        tags: ['Driver portal'],
        summary: 'Receipts this driver has logged',
        security: driverBearer,
        responses: { ...ok('Receipts.'), ...errors },
      },
      post: {
        tags: ['Driver portal'],
        summary: 'Submit a receipt',
        description:
          'Accepts a client-generated id so a retry on a flaky connection cannot log the same receipt twice.',
        security: driverBearer,
        responses: { ...ok('Receipt logged.'), ...errors },
      },
    },
    '/driver/receipts/parse': {
      post: {
        tags: ['Driver portal'],
        summary: 'Parse receipt text into fields',
        security: driverBearer,
        responses: { ...ok('Parsed fields.'), ...errors },
      },
    },
    '/driver/receipts/ocr': {
      post: {
        tags: ['Driver portal'],
        summary: 'Read a receipt photo with Cloud Vision, then parse it',
        security: driverBearer,
        responses: { ...ok('OCR text and parsed fields.'), ...errors },
      },
    },
    '/driver/receipts/station-check': {
      get: {
        tags: ['Driver portal'],
        summary: 'Was the vehicle actually at a filling station then',
        description:
          'Compares the receipt position and time against the recorded track. Corroboration, not a verdict.',
        security: driverBearer,
        responses: { ...ok('Station match result.'), ...errors },
      },
    },

    // -------------------------------------------------------------- alerts
    '/alerts': {
      get: {
        tags: ['Alerts'],
        summary: 'Open alerts',
        responses: { ...ok('Alerts.'), ...errors },
      },
    },
    '/alerts/anomalies': {
      get: {
        tags: ['Alerts'],
        summary: 'Fuel anomalies awaiting review',
        responses: { ...ok('Anomalies.'), ...errors },
      },
    },
    '/alerts/{id}/acknowledge': {
      patch: {
        tags: ['Alerts'],
        summary: 'Acknowledge an alert',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Acknowledged.'), ...errors },
      },
    },

    // ----------------------------------------------------------- geofences
    '/geofences': {
      get: { tags: ['Geofences'], summary: 'Zones', responses: { ...ok('Geofences.'), ...errors } },
      post: { tags: ['Geofences'], summary: 'Create a zone', responses: { ...ok('Created.'), ...errors } },
    },
    '/geofences/{id}': {
      delete: {
        tags: ['Geofences'],
        summary: 'Delete a zone',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Deleted.'), ...errors },
      },
    },
    '/geofences/events': {
      get: {
        tags: ['Geofences'],
        summary: 'Entry and exit events',
        description: 'Evaluated server-side from positions, not by the device.',
        responses: { ...ok('Events.'), ...errors },
      },
    },

    // --------------------------------------------------------- maintenance
    '/maintenance': {
      get: { tags: ['Maintenance'], summary: 'Scheduled work', responses: { ...ok('Items.'), ...errors } },
      post: { tags: ['Maintenance'], summary: 'Schedule work', responses: { ...ok('Created.'), ...errors } },
    },
    '/maintenance/{id}/complete': {
      patch: {
        tags: ['Maintenance'],
        summary: 'Mark work complete',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Completed.'), ...errors },
      },
    },
    '/maintenance/{id}': {
      delete: {
        tags: ['Maintenance'],
        summary: 'Delete a maintenance item',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Deleted.'), ...errors },
      },
    },

    // -------------------------------------------------------- intelligence
    '/intelligence/security': {
      get: {
        tags: ['Intelligence'],
        summary: 'Movement without ignition, unplugs and other security signals',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Security findings.'), ...errors },
      },
    },
    '/intelligence/hours': {
      get: {
        tags: ['Intelligence'],
        summary: 'When the fleet actually works',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Activity by hour and weekday.'), ...errors },
      },
    },
    '/intelligence/utilisation': {
      get: {
        tags: ['Intelligence'],
        summary: 'Which vehicles earn their keep',
        parameters: [daysParam(90, 30)],
        responses: { ...ok('Utilisation ranking.'), ...errors },
      },
    },

    // -------------------------------------------------------------- orders
    '/orders': {
      get: { tags: ['Orders'], summary: 'Tracker orders', responses: { ...ok('Orders.'), ...errors } },
      post: { tags: ['Orders'], summary: 'Place an order', responses: { ...ok('Order placed.'), ...errors } },
    },
    '/orders/{id}/ship': {
      patch: {
        tags: ['Orders'],
        summary: 'Mark an order shipped',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { ...ok('Shipped.'), ...errors },
      },
    },

    // -------------------------------------------------------------- places
    '/places/autocomplete': {
      get: {
        tags: ['Places'],
        summary: 'Place suggestions',
        description: 'Proxied so the Google key never reaches the browser. Calls are metered.',
        responses: { ...ok('Suggestions.'), ...errors },
      },
    },
    '/places/photo': {
      get: { tags: ['Places'], summary: 'Place photo proxy', responses: { ...ok('Image bytes.'), ...errors } },
    },
    '/places/staticmap': {
      get: { tags: ['Places'], summary: 'Static map proxy', responses: { ...ok('Image bytes.'), ...errors } },
    },
    '/places/streetview': {
      get: { tags: ['Places'], summary: 'Street View proxy', responses: { ...ok('Image bytes.'), ...errors } },
    },

    // ------------------------------------------------------------ features
    '/features': {
      get: {
        tags: ['Features'],
        summary: 'Feature flags and why each is on or off',
        description:
          'Several flags stay dark because the hardware does not feed them — the reason is returned so the UI can say so instead of showing an empty panel.',
        responses: { ...ok('Flags.'), ...errors },
      },
    },
    '/features/{key}': {
      patch: {
        tags: ['Features'],
        summary: 'Toggle a flag',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { ...ok('Flag updated.'), ...errors },
      },
    },
    '/features/fuel-config': {
      get: {
        tags: ['Features'],
        summary: 'Thresholds behind fuel detection',
        responses: { ...ok('Refuel and drop thresholds.'), ...errors },
      },
    },
    '/features/documentation': {
      get: {
        tags: ['Features'],
        summary: 'In-app methodology notes',
        responses: { ...ok('Documentation blocks.'), ...errors },
      },
    },
    '/features/calibration-status': {
      get: {
        tags: ['Features'],
        summary: 'Which vehicles are on a class preset versus a measured rate',
        description:
          '`rate_source` distinguishes a preset guess from a figure the manager entered or calibration measured.',
        responses: { ...ok('Per-vehicle calibration state.'), ...errors },
      },
    },
    '/features/notifications/{alertType}': {
      patch: {
        tags: ['Features'],
        summary: 'Opt in or out of an email alert type',
        description: 'A missing preference row means not opted in — notifications are never forced on.',
        parameters: [{ name: 'alertType', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { ...ok('Preference saved.'), ...errors },
      },
    },

    // ------------------------------------------------------------- contact
    '/contact': {
      post: {
        tags: ['Auth'],
        summary: 'Send a sales or support enquiry',
        security: [],
        responses: { ...ok('Enquiry sent.'), ...errors },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;
