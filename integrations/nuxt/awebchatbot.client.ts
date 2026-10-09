/**
 * AWebChatbot for Nuxt 3. Save as plugins/awebchatbot.client.ts and add to nuxt.config.ts:
 *
 *   runtimeConfig: { public: { awebchatbotUrl: 'https://awebchatbot.you.workers.dev', awebchatbotKey: 'pk_...' } }
 *
 * Use anywhere:  const { $chat } = useNuxtApp(); $chat.open()
 */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig().public as { awebchatbotUrl?: string; awebchatbotKey?: string };
  const base = (config.awebchatbotUrl || '').replace(/\/$/, '');
  const key = config.awebchatbotKey || '';

  if (base && key && !document.getElementById('awebchatbot-script')) {
    const script = document.createElement('script');
    script.id = 'awebchatbot-script';
    script.src = `${base}/widget.js`;
    script.async = true;
    script.dataset.key = key;
    document.body.appendChild(script);
  }

  const w = window as unknown as { AWebChatbot?: { ready: boolean; open(): void; close(): void; identify(i: object): Promise<unknown>; sendMessage(t: string): Promise<unknown> } };
  const whenReady = (fn: () => void) => {
    if (w.AWebChatbot?.ready) fn();
    else window.addEventListener('awebchatbot:ready', fn, { once: true });
  };

  return {
    provide: {
      chat: {
        open: () => whenReady(() => w.AWebChatbot?.open()),
        close: () => whenReady(() => w.AWebChatbot?.close()),
        identify: (identity: { name?: string; email?: string; attributes?: Record<string, string> }) =>
          whenReady(() => void w.AWebChatbot?.identify(identity)),
        send: (text: string) => whenReady(() => void w.AWebChatbot?.sendMessage(text)),
      },
    },
  };
});
