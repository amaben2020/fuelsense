import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    CACHE_GEOCODE: process.env.CACHE_GEOCODE,
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  },
};

export default nextConfig;
