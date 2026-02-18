import './globals.css';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { DevnetBanner } from './components/DevnetBanner';

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-sans',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
});

export const metadata = {
  title: 'Provenonce Beats',
  description: 'Stateless time authentication service',
  icons: {
    icon: { url: '/logo.png', type: 'image/png' },
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
        <DevnetBanner />
        {children}
      </body>
    </html>
  );
}
