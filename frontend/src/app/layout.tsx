import type { Metadata } from "next";
import { Archivo, Geist_Mono, Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  // The landing page is the public face, so the default title is the product's
  // rather than the dashboard's — everything behind auth is unindexable anyway.
  title: {
    default: 'FuelSense — every litre, accounted for',
    template: '%s · FuelSense',
  },
  description:
    'Fuel intelligence for Nigerian fleets. Live tracking, trip and idling detection, and fuel cost you can audit — built on Teltonika telemetry.',
  openGraph: {
    title: 'FuelSense — every litre, accounted for',
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
