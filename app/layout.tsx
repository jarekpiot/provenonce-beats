import './globals.css';

export const metadata = {
  title: 'Provenonce Beats',
  description: 'Stateless time authentication service',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
