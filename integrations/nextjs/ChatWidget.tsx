'use client';

/**
 * AWebChatbot for Next.js (App Router or Pages Router).
 *
 * App Router — app/layout.tsx:
 *   import { ChatWidget } from '@/components/ChatWidget';
 *   <body>{children}<ChatWidget /></body>
 *
 * Set NEXT_PUBLIC_AWEBCHATBOT_URL and NEXT_PUBLIC_AWEBCHATBOT_KEY in .env.local (or pass props).
 * Works on Vercel, Cloudflare (OpenNext / next-on-pages) and Fly.io.
 */
import Script from 'next/script';
import { useEffect } from 'react';

type Identity = { name?: string; email?: string; phone?: string; attributes?: Record<string, string | number | boolean> };

declare global {
  interface Window {
    AWebChatbot?: {
      ready: boolean;
      open: () => void;
      close: () => void;
      toggle: () => void;
      identify: (identity: Identity) => Promise<unknown>;
      sendMessage: (text: string) => Promise<unknown>;
      reset: () => void;
      on: (event: string, cb: (data: unknown) => void) => void;
    };
  }
}

export function ChatWidget({
  baseUrl = process.env.NEXT_PUBLIC_AWEBCHATBOT_URL,
  widgetKey = process.env.NEXT_PUBLIC_AWEBCHATBOT_KEY,
  user,
}: {
  baseUrl?: string;
  widgetKey?: string;
  user?: Identity | null;
}) {
  useEffect(() => {
    if (!user) return;
    const identify = () => window.AWebChatbot?.identify(user);
    if (window.AWebChatbot?.ready) identify();
    else window.addEventListener('awebchatbot:ready', identify, { once: true });
    return () => window.removeEventListener('awebchatbot:ready', identify);
  }, [user?.email, user?.name, user?.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!baseUrl || !widgetKey) return null;
  return <Script id="awebchatbot" src={`${baseUrl.replace(/\/$/, '')}/widget.js`} data-key={widgetKey} strategy="afterInteractive" />;
}

/** Open the chat from any button: <button onClick={openChat}>Chat with us</button> */
export function openChat() {
  window.AWebChatbot?.open();
}

export default ChatWidget;
