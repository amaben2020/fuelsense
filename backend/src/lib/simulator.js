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

    return buildCodecRecord({
      fuelLevel: this.fuelLevel,
      odometerKm: Math.round(this.odometerKm),
      lat: this.lat,
      lng: this.lng,
      speedKph: this.speedKph,
      ignitionOn: this.ignitionOn,
      headingDeg: (this.heading * 180) / Math.PI,
      meta: { theftSimulated },
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
  meta = {},
}) => {
  const ioElements = [
    { id: 239, size: 1, value: ignitionOn ? 1 : 0 },
    { id: 112, size: 4, value: odometerKm * 1000 },
    { id: 390, size: 4, value: Math.round(fuelLevel * 100) },
  ];

  return {
    timestamp: Date.now(),
    priority: 0,
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

const DEFAULT_FLEET_PROFILES = [
  {
    imei: '356307042441013',
    label: 'LND-772-AA',
    model: 'Hilux',
    routeLoop: 'island',
    startLat: 6.5244,
    startLng: 3.3792,
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
    startLat: 6.6018,
    startLng: 3.3515,
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
    startLat: 6.4474,
    startLng: 3.4738,
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
    startLat: 6.5789,
    startLng: 3.2802,
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
    startLat: 6.4969,
    startLng: 3.3346,
    initialFuel: 40,
    tankCapacity: 55,
    initialOdometer: 15200,
    theftTarget: true,
    theftAfterTicks: 8,
    theftDropLiters: 22,
    driveCycleTicks: 16,
  },
];

module.exports = {
  VehicleSimulator,
  buildCodecRecord,
  DEFAULT_FLEET_PROFILES,
};
