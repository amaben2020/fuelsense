const { encodeCodec8ePacket } = require('../codec8e-encoder');

/**
 * Stateful virtual FMC150 — each instance drives one TCP connection / IMEI.
 */
class VehicleSimulator {
  constructor(profile) {
    this.profile = profile;
    this.tick = 0;
    this.fuelLevel = profile.initialFuel;
    this.tankCapacity = profile.tankCapacity ?? 60;
    this.odometerKm = profile.initialOdometer;
    this.lat = profile.startLat;
    this.lng = profile.startLng;
    this.heading = profile.heading ?? 0;
    this.ignitionOn = profile.startIgnition ?? true;
    this.speedKph = 0;
    this.phase = 'driving';
    this.phaseTicks = 0;
    this.theftDone = false;
    this.stopped = false;
    this.routeRadius = profile.routeRadius ?? 0.012;
    this.routeSpeed = profile.routeSpeed ?? 0.00008;
    this.fuelAtPark = null;
  }

  nextRecord() {
    if (this.stopped) return null;

    this.tick += 1;
    this.phaseTicks += 1;
    this._advancePhase();

    let theftSimulated = false;

    if (this.phase === 'driving' && this.ignitionOn) {
      this.heading += (Math.random() - 0.5) * 0.4;
      this.lat += Math.cos(this.heading) * this.routeSpeed;
      this.lng += Math.sin(this.heading) * this.routeSpeed;
      this.speedKph = Math.round(25 + Math.random() * 55);
      const burn = 0.08 + this.speedKph * 0.0015;
      this.fuelLevel = Math.max(2, this.fuelLevel - burn);
      this.odometerKm += this.speedKph / 3600;
    } else if (this.phase === 'idle' && this.ignitionOn) {
      this.speedKph = 0;
      this.fuelLevel = Math.max(2, this.fuelLevel - 0.02);
    } else {
      this.speedKph = 0;
      this.ignitionOn = false;
    }

    if (this.profile.refuelEvery && this.tick % this.profile.refuelEvery === 0) {
      this.fuelLevel = Math.min(this.tankCapacity, this.fuelLevel + 25);
    }

    let includeFuel = this.ignitionOn;

    if (this.phase === 'theft' && !this.theftDone) {
      const drop = this.profile.theftDropLiters ?? 18;
      this.fuelLevel = Math.max(2, (this.fuelAtPark ?? this.fuelLevel) - drop);
      includeFuel = true;
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
      includeFuel,
      meta: { theftSimulated },
    });
  }

  _advancePhase() {
    const p = this.profile;

    if (p.theftTarget && !this.theftDone) {
      if (this.phase === 'theft' || this.phase === 'pre_theft_park') return;

      if (this.phaseTicks >= (p.theftAfterTicks ?? 12)) {
        this.phase = 'pre_theft_park';
        this.phaseTicks = 0;
        this.ignitionOn = false;
        this.speedKph = 0;
        this.fuelAtPark = this.fuelLevel;
        return;
      }
    }

    if (this.phase === 'pre_theft_park') {
      if (this.phaseTicks >= (p.theftParkTicks ?? 2)) {
        this.phase = 'theft';
        this.phaseTicks = 0;
      }
      return;
    }

    const cycle = p.driveCycleTicks ?? 25;
    if (this.phaseTicks >= cycle) {
      this.phaseTicks = 0;
      if (this.phase === 'driving') {
        this.phase = p.idleRatio > Math.random() ? 'idle' : 'parked';
        this.ignitionOn = this.phase === 'idle';
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
  includeFuel,
  meta = {},
}) => {
  const ioElements = [
    { id: 239, size: 1, value: ignitionOn ? 1 : 0 },
    { id: 112, size: 4, value: odometerKm * 1000 },
  ];

  if (includeFuel && fuelLevel != null) {
    ioElements.push({ id: 390, size: 4, value: Math.round(fuelLevel * 100) });
  }

  return {
    timestamp: Date.now(),
    priority: 0,
    gps: {
      latitude: lat,
      longitude: lng,
      altitude: 80 + Math.random() * 40,
      angle: Math.floor(Math.random() * 360),
      satellites: Math.floor(Math.random() * 8) + 8,
      speed: speedKph,
    },
    ioElements,
    meta: { fuelLevel, ignitionOn, speedKph, ...meta },
  };
};

const DEFAULT_FLEET_PROFILES = [
  {
    imei: '356307042441013',
    label: 'ABC-123',
    startLat: 6.5244,
    startLng: 3.3792,
    heading: 0.5,
    initialFuel: 42,
    tankCapacity: 60,
    initialOdometer: 45230,
    routeSpeed: 0.0001,
  },
  {
    imei: '356307042441014',
    label: 'LAG-456-CD',
    startLat: 6.6018,
    startLng: 3.3515,
    heading: 1.2,
    initialFuel: 32,
    tankCapacity: 55,
    initialOdometer: 67890,
    idleRatio: 0.35,
    theftTarget: true,
    theftAfterTicks: 18,
    theftDropLiters: 20,
    driveCycleTicks: 22,
  },
  {
    imei: '356307042441015',
    label: 'LAG-789-EF',
    startLat: 6.4474,
    startLng: 3.4738,
    heading: 2.1,
    initialFuel: 35,
    tankCapacity: 70,
    initialOdometer: 102345,
    driveCycleTicks: 18,
    idleRatio: 0.5,
  },
  {
    imei: '356307042441016',
    label: 'ABJ-101-GH',
    startLat: 6.5789,
    startLng: 3.2802,
    heading: 0.9,
    initialFuel: 52,
    tankCapacity: 50,
    initialOdometer: 8901,
    offlineAfterTicks: 45,
    routeSpeed: 0.00006,
  },
  {
    imei: '356307042441017',
    label: 'RIV-202-IJ',
    startLat: 6.4969,
    startLng: 3.3346,
    heading: 1.8,
    initialFuel: 40,
    tankCapacity: 55,
    initialOdometer: 15200,
    theftTarget: true,
    theftAfterTicks: 10,
    theftDropLiters: 22,
    driveCycleTicks: 20,
  },
];

module.exports = {
  VehicleSimulator,
  buildCodecRecord,
  DEFAULT_FLEET_PROFILES,
};
