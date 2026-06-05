import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    CACHE_GEOCODE: process.env.CACHE_GEOCODE,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:5001/api/:path*',
      },
    ];
  },
};

export default nextConfig;
