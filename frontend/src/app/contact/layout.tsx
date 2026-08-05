import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Talk to FuelSense about Teltonika FMC150 trackers, fleet setup, or a demo. We supply and configure hardware for Nigerian fleets, or work with trackers you already run.',
  alternates: { canonical: '/contact' },
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return children;
}
