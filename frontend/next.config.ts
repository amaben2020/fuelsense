import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Every route prerenders, so the site ships as plain files. No Node process
  // to keep alive, and any static host can serve it.
  output: 'export',
  env: {
    CACHE_GEOCODE: process.env.CACHE_GEOCODE,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  },
  images: {
    remotePatterns: [],
    // Static export ships no image optimiser.
    unoptimized: true,
  },
};

export default nextConfig;
