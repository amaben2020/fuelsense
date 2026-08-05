import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingFooter, MarketingNav } from '@/components/marketing/MarketingChrome';
import '../marketing.css';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'FuelSense pricing for Nigerian fleets: per vehicle per month from ₦3,500, with fuel and idling intelligence from ₦7,500. Annual payment covers twelve months for the price of ten.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'FuelSense pricing',
    description:
      'Per vehicle per month, from ₦3,500. Fuel and idling intelligence from ₦7,500. Volume pricing for large fleets.',
  },
};

interface Tier {
  name: string;
  audience: string;
  price: string;
  unit: string;
  features: string[];
  featured?: boolean;
  cta: string;
}

const TIERS: Tier[] = [
  {
    name: 'Essential Sense',
    audience: 'Small delivery setups, ride-hailing partners, local dispatch',
    price: '₦3,500 – ₦5,000',
    unit: 'per vehicle, per month',
    features: [
      'Live GPS tracking on a shared map',
      'Automatic trip logbooks from ignition',
      'Odometer and distance reporting',
      'Stop detection with real addresses',
      'Email alerts for tracker tampering',
    ],
    cta: 'Start here',
  },
  {
    name: 'Active Control',
    audience: 'Mid-size haulage, interstate logistics, corporate staff buses',
    price: '₦7,500 – ₦10,000',
    unit: 'per vehicle, per month',
    featured: true,
    features: [
      'Everything in Essential Sense',
      'Fuel used from GNSS telemetry (AVL 12)',
      'Live burn rate and cost per kilometre (AVL 13)',
      'Idling measured to the minute and priced in naira',
      'Harsh braking, acceleration and cornering events',
      'Driver receipt upload with OCR reconciliation',
      'Monthly executive fuel summary',
    ],
    cta: 'Most fleets pick this',
  },
  {
    name: 'Enterprise Scale',
    audience: 'Large fleets of 50+, construction, heavy machinery',
    price: 'Volume pricing',
    unit: 'quoted on fleet size',
    features: [
      'Everything in Active Control',
      'API access for your own systems',
      'Custom discrepancy rules and thresholds',
      'Multi-user access with roles',
      'Named support contact',
    ],
    cta: 'Talk to us',
  },
];

const COMMERCIALS = [
  {
    title: 'Pay annually, get two months',
    body: 'Twelve months active for the price of ten. Each tracker carries a SIM with a monthly data cost, so paying up front covers that and spares your accounts team chasing a small invoice per vehicle every month.',
  },
  {
    title: 'One-time activation, ₦15,000 to ₦25,000 per tracker',
    body: 'Covers flashing the FuelSense profile onto the device, setting the consumption baseline for that specific engine, and proving the vehicle is reporting before it leaves. A tracker configured on defaults reports fuel figures that are wrong from day one.',
  },
  {
    title: 'Bring your own trackers, or take them from us',
    body: 'If you already run FMC150s we configure them and charge software only. If you do not, we supply the hardware configured for your vehicles. Either way the subscription is the same.',
  },
];

export default function PricingPage() {
  return (
    <div className="fs-landing">
      <MarketingNav />

      <section className="fs-shell fs-hero">
        <span className="fs-eyebrow">Pricing</span>
        <h1 className="fs-display" style={{ marginTop: '1.5rem', maxWidth: '14ch' }}>
          Priced per <em>vehicle</em>, per month.
        </h1>
        <p className="fs-lede" style={{ marginTop: '1.5rem' }}>
          One vehicle or fifty, you pay for what is reporting. No licence to buy, no minimum
          fleet size, and no charge for a vehicle that is off the road.
        </p>
      </section>

      <section className="fs-shell fs-section" style={{ paddingTop: 0, borderTop: 0 }}>
        <div className="fs-tiers">
          {TIERS.map((tier) => (
            <article
              key={tier.name}
              className={`fs-tier${tier.featured ? ' fs-tier--featured' : ''}`}
            >
              <h2 className="fs-tier__name">{tier.name}</h2>
              <p className="fs-tier__audience">{tier.audience}</p>

              <p className="fs-tier__price">{tier.price}</p>
              <p className="fs-tier__unit">{tier.unit}</p>

              <ul className="fs-tier__features">
                {tier.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>

              <Link
                href="/contact"
                className={`fs-btn ${tier.featured ? 'fs-btn--primary' : 'fs-btn--ghost'}`}
                style={{ marginTop: 'auto', justifyContent: 'center' }}
              >
                {tier.cta}
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="fs-shell fs-section">
        <h2 className="fs-h2">How the money actually works.</h2>
        <div className="fs-featgrid" style={{ marginTop: '2.5rem' }}>
          {COMMERCIALS.map((item) => (
            <div className="fs-feat" key={item.title}>
              <h3 className="fs-feat__name">{item.title}</h3>
              <p className="fs-small">{item.body}</p>
            </div>
          ))}
          <div className="fs-feat">
            <h3 className="fs-feat__name">What you are actually buying</h3>
            <p className="fs-small">
              A vehicle doing 2,000 km a month at 7 km/L burns roughly 286 L, about ₦380,000 at
              ₦1,330. Cutting idling and correcting one wrong consumption profile is worth more
              per month than the subscription costs.
            </p>
          </div>
        </div>
      </section>

      <section className="fs-shell fs-section" style={{ borderTop: 0 }}>
        <div className="fs-cta">
          <h2 className="fs-h2">
            Tell us what you run, and we will <em>price</em> it.
          </h2>
          <p className="fs-lede" style={{ color: 'rgba(255,254,251,0.72)', marginTop: '1.25rem' }}>
            Fleet size, vehicle types, and whether you already own trackers. We will come back
            with a figure and a payback estimate.
          </p>
          <div className="fs-hero__actions">
            <Link
              href="/contact"
              className="fs-btn"
              style={{ background: 'var(--green-electric)', color: '#04231a' }}
            >
              Get a quote
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
