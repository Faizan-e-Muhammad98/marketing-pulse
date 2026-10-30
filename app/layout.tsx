import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Marketing Pulse',
  description: 'Read-only Marketing telemetry',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
