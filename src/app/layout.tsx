// public: the root shell; renders no data
import './globals.css';

export const metadata = { title: { default: 'Earmark', template: '%s · Earmark' }, description: 'Marketing budget and agency-spend governance.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
