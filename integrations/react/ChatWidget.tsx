/**
 * AWebChatbot for React (Vite, CRA, Remix client, etc.).
 *   <ChatWidget baseUrl="https://awebchatbot.you.workers.dev" widgetKey="pk_..." user={currentUser} />
 * Render once near the root of your app.
 */
import { useEffect } from 'react';

type Identity = { name?: string; email?: string; phone?: string; attributes?: Record<string, string | number | boolean> };

type AWebChatbotApi = {
  ready: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  identify: (identity: Identity) => Promise<unknown>;
  sendMessage: (text: string) => Promise<unknown>;
  reset: () => void;
  on: (event: string, cb: (data: unknown) => void) => void;
};

function api(): AWebChatbotApi | undefined {
  return (window as unknown as { AWebChatbot?: AWebChatbotApi }).AWebChatbot;
}

export function ChatWidget({ baseUrl, widgetKey, user }: { baseUrl: string; widgetKey: string; user?: Identity | null }) {
  useEffect(() => {
    if (document.getElementById('awebchatbot-script')) return;
    const script = document.createElement('script');
    script.id = 'awebchatbot-script';
    script.src = `${baseUrl.replace(/\/$/, '')}/widget.js`;
    script.async = true;
    script.dataset.key = widgetKey;
    document.body.appendChild(script);
  }, [baseUrl, widgetKey]);

  useEffect(() => {
    if (!user) return;
    const identify = () => api()?.identify(user);
    if (api()?.ready) identify();
    else window.addEventListener('awebchatbot:ready', identify, { once: true });
    return () => window.removeEventListener('awebchatbot:ready', identify);
  }, [user?.email, user?.name, user?.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export const chat = {
  open: () => api()?.open(),
  close: () => api()?.close(),
  toggle: () => api()?.toggle(),
  send: (text: string) => api()?.sendMessage(text),
};

export default ChatWidget;
