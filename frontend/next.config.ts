import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    CACHE_GEOCODE: process.env.CACHE_GEOCODE,
  },
};

export default nextConfig;
