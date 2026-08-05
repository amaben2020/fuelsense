const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fuelsense.ng';

/**
 * JSON-LD describing the product in machine-readable form.
 *
 * Search engines use it for rich results; assistants use it to answer
 * questions about what FuelSense is without having to infer it from prose.
 * The claims here are deliberately the same ones the page makes in words,
 * including the limits: a product that overstates itself in structured data
 * gets quoted overstating itself.
 */
const GRAPH = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#organization`,
      name: 'FuelSense',
      url: SITE,
      email: 'uzochukwubenamara@gmail.com',
      areaServed: { '@type': 'Country', name: 'Nigeria' },
      description:
        'Fleet fuel intelligence for Nigerian operators, built on Teltonika GPS telemetry.',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: SITE,
      name: 'FuelSense',
      publisher: { '@id': `${SITE}/#organization` },
      inLanguage: 'en-NG',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#software`,
      name: 'FuelSense',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Fleet management and fuel monitoring',
      operatingSystem: 'Web browser',
      url: SITE,
      publisher: { '@id': `${SITE}/#organization` },
      description:
        'FuelSense turns Teltonika FMC150 telemetry into auditable fuel cost: distance, engine hours, idling, fuel burned and what it cost in naira. It requires no fuel-level sensor and no CAN adapter.',
      featureList: [
        'Live GPS tracking with automatic trip segmentation',
        'Stop detection with real addresses',
        'Idling time measured to the minute and priced in naira',
        'Fuel consumption from GNSS telemetry (AVL 12 and AVL 13)',
        'Driver receipt upload with OCR and reconciliation against measured burn',
        'Effective-dated fuel pricing so past periods keep their own price',
        'Driving behaviour events and per-driver scoring',
      ],
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'NGN',
        lowPrice: '3500',
        highPrice: '10000',
        offerCount: 3,
        unitText: 'per vehicle per month',
        url: `${SITE}/pricing`,
      },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Does FuelSense need a fuel-level sensor in the tank?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. The Teltonika FMC150 computes fuel consumption in firmware from satellite-measured movement against the vehicle’s configured consumption profile, reported as AVL 12 (fuel used) and AVL 13 (burn rate). Nothing is fitted to the tank or spliced into the fuel line.',
          },
        },
        {
          '@type': 'Question',
          name: 'How accurate is GPS-derived fuel measurement?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'It is a model, not a measurement, and its accuracy depends on the consumption profile configured on the device. FuelSense cross-checks the device’s two fuel elements against each other and calibrates the result against litres actually paid for on receipts, then reports a confidence figure rather than claiming certainty.',
          },
        },
        {
          '@type': 'Question',
          name: 'Can FuelSense detect fuel theft or siphoning?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Not directly. Without a fuel-level sensor or CAN bus connection there is no way to observe fuel leaving a tank. FuelSense instead compares litres purchased on receipts against burn measured from the vehicle’s movement, and raises any gap as a discrepancy for a manager to investigate rather than as an accusation.',
          },
        },
        {
          '@type': 'Question',
          name: 'What does FuelSense cost?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Pricing is per vehicle per month across three tiers: Essential Sense from ₦3,500 for tracking and trip logs, Active Control from ₦7,500 adding fuel and idling intelligence, and Enterprise Scale priced by volume for large fleets. A one-time activation fee covers configuring each tracker, and paying annually covers twelve months for the price of ten.',
          },
        },
      ],
    },
  ],
};

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      // Static, developer-authored JSON with no user input in it.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(GRAPH) }}
    />
  );
}
