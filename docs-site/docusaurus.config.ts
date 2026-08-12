import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// Engineering documentation for FuelSense.
//
// Docs-only: the blog and the marketing landing page are deliberately turned
// off. Everything here is reference material for people building or operating
// the system, and the product pitch already lives on the app's own landing page.

const config: Config = {
  title: 'FuelSense Engineering',
  tagline: 'How fleet fuel is measured, modelled and priced',
  favicon: 'img/logo.svg',

  future: { v4: true },

  url: 'https://docs.fuelsense.ng',
  baseUrl: '/',

  organizationName: 'fuelsense',
  projectName: 'fuelsense',

  // A broken cross-reference in an architecture doc is worse than a build
  // failure — it sends someone looking for a page that describes a behaviour
  // they are about to rely on.
  onBrokenLinks: 'throw',

  i18n: { defaultLocale: 'en', locales: ['en'] },

  markdown: {
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'throw' },
  },
  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Docs are the site. Serving them from the root removes a redundant
          // /docs hop on every URL.
          routeBasePath: '/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
    navbar: {
      title: 'FuelSense',
      logo: { alt: 'FuelSense', src: 'img/logo.svg' },
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Documentation' },
        { href: 'https://api.fuelsense.ng/api/docs', label: 'API reference', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Start here',
          items: [
            { label: 'Overview', to: '/' },
            { label: 'Architecture', to: '/architecture/system' },
            { label: 'What the hardware sends', to: '/data/avl-elements' },
          ],
        },
        {
          title: 'Accuracy',
          items: [
            { label: 'The fuel model', to: '/data/fuel-model' },
            { label: 'Driving events', to: '/data/driving-events' },
            { label: 'Pricing', to: '/data/pricing' },
          ],
        },
      ],
      copyright: `FuelSense · ${new Date().getFullYear()}`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['sql', 'bash'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
