const {
  sampleEfficiencyKmL,
  fuelUsedForDistanceKm,
  idleFuelBurnLiters,
} = require('./fuel-metrics');
const { loopForProfile } = require('./lagos-routes');

/**
 * Stateful virtual FMC150 — Uber-style routes, physics-based fuel + odometer.
 */
class VehicleSimulator {
  constructor(profile) {
    this.profile = profile;
    this.tick = 0;
    this.fuelLevel = profile.initialFuel;
    this.tankCapacity = profile.tankCapacity ?? 60;
    this.odometerKm = profile.initialOdometer;
    this.waypoints = loopForProfile(profile);
    this.waypointIndex = 0;
    const start = this.waypoints[0];
    this.lat = profile.startLat ?? start.lat;
    this.lng = profile.startLng ?? start.lng;
    this.heading = profile.heading ?? 0;
    this.ignitionOn = profile.startIgnition ?? true;
    this.speedKph = 0;
    this.phase = 'driving';
    this.phaseTicks = 0;
    this.theftDone = false;
    this.stopped = false;
    this.fuelAtPark = null;
    this.tickIntervalMs = profile.tickIntervalMs ?? 4000;
    this.efficiencyKmL =
      profile.efficiencyKmL ?? sampleEfficiencyKmL(profile.model ?? 'Hiace');
    this.imei = profile.imei;
    this.prevIgnition = this.ignitionOn;
    this.prevIdle = false;
    this.pendingEvents = [];
    this.securityEventsFired = new Set();
  }

  // FMC150 scenario events ride on eventful records: the AVL event field names
  // the triggering IO element. One event per record, so extras queue up.
  _queueEvent(eventId, ioElements) {
    this.pendingEvents.push({ eventId, ioElements });
  }

  _generateScenarioEvents() {
    // Trip start/stop on ignition transitions (AVL 250)
    if (this.ignitionOn !== this.prevIgnition) {
      this._queueEvent(250, [{ id: 250, size: 1, value: this.ignitionOn ? 1 : 0 }]);
    }

    // Excessive idling start/end (AVL 251)
    const isIdle = this.ignitionOn && this.phase === 'idle';
    if (isIdle !== this.prevIdle) {
      this._queueEvent(251, [{ id: 251, size: 1, value: isIdle ? 1 : 0 }]);
    }

    if (this.phase === 'driving' && this.ignitionOn) {
      // Occasional green-driving violations (AVL 253 type + 254 g×100)
      if (Math.random() < 0.04) {
        const type = 1 + Math.floor(Math.random() * 3);
        const gTimes100 = 25 + Math.floor(Math.random() * 40);
        this._queueEvent(253, [
          { id: 253, size: 1, value: type },
          { id: 254, size: 1, value: gTimes100 },
        ]);
      }

      // Occasional overspeed burst (AVL 255 carries the speed)
      if (Math.random() < 0.03) {
        this.speedKph = 92 + Math.floor(Math.random() * 18);
        this._queueEvent(255, [{ id: 255, size: 2, value: this.speedKph }]);
      }
    }

    // Scripted security incidents for demo profiles
    if (this.profile.securityDemo) {
      const fireOnce = (key, tick, eventId, ioElements) => {
        if (this.tick >= tick && !this.securityEventsFired.has(key)) {
          this.securityEventsFired.add(key);
          this._queueEvent(eventId, ioElements);
        }
      };
      fireOnce('towing', 30, 246, [{ id: 246, size: 1, value: 1 }]);
      fireOnce('jam_on', 60, 249, [{ id: 249, size: 1, value: 1 }]);
      fireOnce('jam_off', 63, 249, [{ id: 249, size: 1, value: 0 }]);
      fireOnce('unplug', 90, 252, [{ id: 252, size: 1, value: 1 }]);
      fireOnce('replug', 94, 252, [{ id: 252, size: 1, value: 0 }]);
    }

    this.prevIgnition = this.ignitionOn;
    this.prevIdle = isIdle;
  }

  _moveTowardWaypoint(distanceKm) {
    const target = this.waypoints[this.waypointIndex];
    const dLat = target.lat - this.lat;
    const dLng = target.lng - this.lng;
    const distDeg = Math.sqrt(dLat * dLat + dLng * dLng);
    const kmPerDegLat = 111;
    const distKm = distDeg * kmPerDegLat;

    if (distKm < 0.15) {
      this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
      return distanceKm;
    }

    const stepKm = Math.min(distanceKm, distKm);
    const ratio = stepKm / distKm;
    this.lat += dLat * ratio;
    this.lng += dLng * ratio;
    this.heading = Math.atan2(dLng, dLat);
    return stepKm;
  }

  nextRecord() {
    if (this.stopped) return null;

    this.tick += 1;
    this.phaseTicks += 1;
    this._advancePhase();

    let theftSimulated = false;
    const intervalHours = this.tickIntervalMs / 3600000;

    if (this.phase === 'driving' && this.ignitionOn) {
      this.speedKph = Math.round(35 + Math.random() * 40);
      let distanceKm = this.speedKph * intervalHours;
      distanceKm = this._moveTowardWaypoint(distanceKm);
      this.odometerKm += distanceKm;
      const burn = fuelUsedForDistanceKm(distanceKm, this.efficiencyKmL);
      this.fuelLevel = Math.max(8, this.fuelLevel - burn);
    } else if (this.phase === 'idle' && this.ignitionOn) {
      this.speedKph = 0;
      this.fuelLevel = Math.max(8, this.fuelLevel - idleFuelBurnLiters(intervalHours));
    } else {
      this.speedKph = 0;
      this.ignitionOn = false;
    }

    if (this.profile.refuelEvery && this.tick % this.profile.refuelEvery === 0) {
      this.fuelLevel = Math.min(this.tankCapacity, this.fuelLevel + 28);
    }

    if (this.fuelLevel < 14 && this.phase === 'driving') {
      this.fuelLevel = Math.min(this.tankCapacity, this.fuelLevel + 30);
    }

    if (this.phase === 'theft' && !this.theftDone) {
      const drop = this.profile.theftDropLiters ?? 18;
      this.fuelLevel = Math.max(8, (this.fuelAtPark ?? this.fuelLevel) - drop);
      this.theftDone = true;
      this.phase = 'parked';
      this.phaseTicks = 0;
      theftSimulated = true;
    }

    if (this.profile.offlineAfterTicks && this.tick >= this.profile.offlineAfterTicks) {
      this.stopped = true;
      return null;
    }

    this._generateScenarioEvents();
    const scenarioEvent = this.pendingEvents.shift() ?? null;

    return buildCodecRecord({
      fuelLevel: this.fuelLevel,
      odometerKm: Math.round(this.odometerKm),
      lat: this.lat,
      lng: this.lng,
      speedKph: this.speedKph,
      ignitionOn: this.ignitionOn,
      headingDeg: (this.heading * 180) / Math.PI,
      eventId: scenarioEvent?.eventId ?? 0,
      extraIo: scenarioEvent?.ioElements ?? [],
      meta: { theftSimulated, scenarioEventId: scenarioEvent?.eventId },
    });
  }

  _advancePhase() {
    const p = this.profile;

    if (p.theftTarget && !this.theftDone) {
      if (this.phase === 'theft' || this.phase === 'pre_theft_park') return;

      if (this.phaseTicks >= (p.theftAfterTicks ?? 10)) {
        this.phase = 'pre_theft_park';
        this.phaseTicks = 0;
        this.ignitionOn = false;
        this.speedKph = 0;
        this.fuelAtPark = this.fuelLevel;
        return;
      }
    }

    if (this.phase === 'pre_theft_park') {
      if (this.phaseTicks >= (p.theftParkTicks ?? 3)) {
        this.phase = 'theft';
        this.phaseTicks = 0;
      }
      return;
    }

    const cycle = p.driveCycleTicks ?? 20;
    if (this.phaseTicks >= cycle) {
      this.phaseTicks = 0;
      if (this.phase === 'driving') {
        const idleChance = p.idleRatio ?? 0.2;
        if (p.idleTarget || idleChance > Math.random()) {
          this.phase = 'idle';
          this.ignitionOn = true;
        } else {
          this.phase = 'parked';
          this.ignitionOn = false;
        }
      } else if (this.phase !== 'theft') {
        this.phase = 'driving';
        this.ignitionOn = true;
      }
    }
  }
}

const buildCodecRecord = ({
  fuelLevel,
  odometerKm,
  lat,
  lng,
  speedKph,
  ignitionOn,
  headingDeg = 0,
  eventId = 0,
  extraIo = [],
  meta = {},
}) => {
  const ioElements = [
    { id: 239, size: 1, value: ignitionOn ? 1 : 0 },
    { id: 112, size: 4, value: odometerKm * 1000 },
    { id: 390, size: 4, value: Math.round(fuelLevel * 100) },
    ...extraIo,
  ];

  return {
    timestamp: Date.now(),
    priority: 0,
    eventId,
    gps: {
      latitude: lat,
      longitude: lng,
      altitude: 80 + Math.random() * 40,
      angle: Math.round(((headingDeg % 360) + 360) % 360),
      satellites: Math.floor(Math.random() * 4) + 10,
      speed: speedKph,
    },
    ioElements,
    meta: { fuelLevel, ignitionOn, speedKph, odometerKm, ...meta },
  };
};

// NOTE: these profiles intentionally carry NO startLat/startLng. Each
// vehicle's origin is resolved at runtime from its device's last real
// telemetry fix (fleet-simulator.js -> withResolvedOrigins). Re-adding a
// coordinate here would reintroduce the bug where the map asserted a location
// the device had never reported.
const DEFAULT_FLEET_PROFILES = [
  {
    imei: '356307042441013',
    label: 'LND-772-AA',
    model: 'Hilux',
    routeLoop: 'island',
    initialFuel: 42,
    tankCapacity: 60,
    initialOdometer: 45230,
    idleTarget: true,
    idleRatio: 0.45,
    driveCycleTicks: 14,
  },
  {
    imei: '356307042441014',
    label: 'IKD-109-BY',
    model: 'Hiace',
    routeLoop: 'mainland',
    initialFuel: 48,
    tankCapacity: 55,
    initialOdometer: 67890,
    theftTarget: true,
    theftAfterTicks: 14,
    theftDropLiters: 20,
    driveCycleTicks: 18,
    refuelEvery: 80,
  },
  {
    imei: '356307042441015',
    label: 'GGE-442-XM',
    model: 'Hilux',
    routeLoop: 'lekki',
    initialFuel: 35,
    tankCapacity: 70,
    initialOdometer: 102345,
    driveCycleTicks: 16,
  },
  {
    imei: '356307042441016',
    label: 'KJA-901-CS',
    model: 'Camry',
    routeLoop: 'ikeja',
    initialFuel: 52,
    tankCapacity: 50,
    initialOdometer: 8901,
    driveCycleTicks: 18,
  },
  {
    imei: '356307042441017',
    label: 'PHC-302-RY',
    model: 'RAV4',
    routeLoop: 'yaba',
    initialFuel: 40,
    tankCapacity: 55,
    initialOdometer: 15200,
    theftTarget: true,
    theftAfterTicks: 8,
    theftDropLiters: 22,
    driveCycleTicks: 16,
    securityDemo: true,
  },
];

module.exports = {
  VehicleSimulator,
  buildCodecRecord,
  DEFAULT_FLEET_PROFILES,
};
