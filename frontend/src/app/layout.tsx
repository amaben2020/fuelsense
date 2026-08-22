import type { Metadata } from "next";
import { Archivo, Geist_Mono, Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { StructuredData } from "@/components/marketing/StructuredData";
import { GreenDrivingBadge } from "@/components/dashboard/GreenDrivingBadge";

const interSans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Marketing surface only — a printed-broadsheet trio the dashboard never uses.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://fuelsense.ng';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  alternates: { canonical: '/' },
  applicationName: 'FuelSense',
  keywords: [
    'fleet fuel monitoring Nigeria',
    'GPS fuel tracking',
    'Teltonika FMC150',
    'fleet management software Nigeria',
    'fuel consumption tracking',
    'vehicle tracking Lagos Abuja',
    'idling cost tracking',
  ],
  robots: { index: true, follow: true },
  // The landing page is the public face, so the default title is the
  // product's rather than the dashboard's. Everything behind auth is
  // unindexable anyway.
  title: {
    default: 'FuelSense, every litre accounted for',
    template: '%s · FuelSense',
  },
  description:
    'Fuel intelligence for Nigerian fleets. Live tracking, trip and idling detection, and fuel cost you can audit, built on Teltonika telemetry.',
  openGraph: {
    url: SITE,
    locale: 'en_NG',
    title: 'FuelSense, every litre accounted for',
    description:
      'Live tracking, trip and idling detection, and fuel cost you can audit, for Nigerian fleets.',
    siteName: 'FuelSense',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${interSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${archivo.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('fuelsense_theme')==='light'){document.documentElement.classList.add('light')}}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <StructuredData />
        {children}
        {/* Mounted at the root so it appears on every page: it qualifies the
            safety score, which is surfaced across the dashboard, not only on
            the driving-behaviour panel. Renders nothing for signed-out
            visitors, or when the trackers are not reporting Eco Driving. */}
        <GreenDrivingBadge />
      </body>
    </html>
  );
}
