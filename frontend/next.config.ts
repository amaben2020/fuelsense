import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    CACHE_GEOCODE: process.env.CACHE_GEOCODE,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
