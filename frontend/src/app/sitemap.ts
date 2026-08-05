import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fuelsense.ng';

// Only the pages worth landing on from a search result. Everything behind
// authentication is excluded for the same reason robots.ts disallows it.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: `${SITE}/`, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE}/contact`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE}/documentation`, lastModified, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/register`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${SITE}/login`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
