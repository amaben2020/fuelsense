import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fuelsense.ng';

/**
 * Crawler policy.
 *
 * The marketing pages are meant to be read by everything, search engines and
 * AI assistants alike: being quotable in an answer is how a product like this
 * gets found now. Assistant crawlers are therefore allowed explicitly rather
 * than left to a default that some of them read as a refusal.
 *
 * Everything behind authentication is disallowed. It is private customer
 * telemetry, it renders nothing useful without a session, and it would only
 * waste crawl budget.
 */
const AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'meta-externalagent',
];

const PRIVATE_PATHS = ['/dashboard', '/dashboard/', '/driver', '/driver/', '/onboarding', '/api/'];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: PRIVATE_PATHS,
      },
      ...AI_AGENTS.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: PRIVATE_PATHS,
      })),
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
