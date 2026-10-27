import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'AWebChatbot — one support desk for every site',
  description:
    'An AI chatbot and live chat for breachmodal.com, isshereal.com, betmodal.com and robomodal.com, answered from one shared inbox.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const base = process.env.NEXT_PUBLIC_AWEBCHATBOT_URL?.replace(/\/$/, '');
  const key = process.env.NEXT_PUBLIC_AWEBCHATBOT_KEY;
  return (
    <html lang="en">
      <body>
        {children}
        {base && key ? <Script src={`${base}/widget.js`} data-key={key} strategy="afterInteractive" /> : null}
      </body>
    </html>
  );
}
