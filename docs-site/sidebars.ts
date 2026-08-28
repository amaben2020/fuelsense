import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Ordered as someone actually onboards: what the system is, how a frame becomes
// a figure, what the hardware can and cannot tell you, then how to run it.
const sidebars: SidebarsConfig = {
  docs: [
    'overview',
    {
      type: 'category',
      label: 'Architecture',
      collapsed: false,
      items: ['architecture/system', 'architecture/ingest', 'architecture/data-model'],
    },
    {
      type: 'category',
      label: 'Measurement and modelling',
      collapsed: false,
      items: [
        'data/avl-elements',
        'data/distance',
        'data/fuel-model',
        'data/driving-events',
        'data/pricing',
        'data/anomalies',
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      collapsed: false,
      items: [
        'operations/deployment',
        'operations/calibration',
        'operations/troubleshooting',
        'operations/observability',
        'operations/google-spend',
      ],
    },
  ],
};

export default sidebars;
