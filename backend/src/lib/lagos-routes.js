/** Lagos corridor waypoints for Uber-style continuous fleet simulation */
const LAGOS_LOOPS = {
  island: [
    { lat: 6.5244, lng: 3.3792 },
    { lat: 6.5355, lng: 3.3621 },
    { lat: 6.5488, lng: 3.3515 },
    { lat: 6.5612, lng: 3.3688 },
    { lat: 6.5520, lng: 3.3910 },
    { lat: 6.5310, lng: 3.3955 },
  ],
  mainland: [
    { lat: 6.6018, lng: 3.3515 },
    { lat: 6.6180, lng: 3.3302 },
    { lat: 6.6055, lng: 3.3050 },
    { lat: 6.5850, lng: 3.3120 },
    { lat: 6.5789, lng: 3.3350 },
  ],
  lekki: [
    { lat: 6.4474, lng: 3.4738 },
    { lat: 6.4620, lng: 3.4900 },
    { lat: 6.4550, lng: 3.5150 },
    { lat: 6.4380, lng: 3.5020 },
    { lat: 6.4410, lng: 3.4780 },
  ],
  ikeja: [
    { lat: 6.5789, lng: 3.2802 },
    { lat: 6.5950, lng: 3.2650 },
    { lat: 6.6100, lng: 3.2850 },
    { lat: 6.5920, lng: 3.3050 },
  ],
  yaba: [
    { lat: 6.4969, lng: 3.3346 },
    { lat: 6.5120, lng: 3.3480 },
    { lat: 6.5050, lng: 3.3720 },
    { lat: 6.4880, lng: 3.3580 },
  ],
};

function loopForProfile(profile) {
  if (profile.routeLoop) return LAGOS_LOOPS[profile.routeLoop];
  return LAGOS_LOOPS.island;
}

module.exports = { LAGOS_LOOPS, loopForProfile };
