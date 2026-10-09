export const PLATFORMS = ['html', 'wordpress', 'shopify', 'nextjs', 'react', 'nuxt', 'cloudflare', 'gtm'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface InstallCode {
  platform: Platform;
  snippet: string;
  language: string;
  steps: string[];
}

export function scriptTag(base: string, key: string): string {
  return `<script src="${base}/widget.js" data-key="${key}" async></script>`;
}

export function installCode(base: string, key: string, platform: Platform): InstallCode {
  const tag = scriptTag(base, key);
  switch (platform) {
    case 'html':
      return {
        platform,
        language: 'html',
        snippet: tag,
        steps: [
          'Paste the snippet just before the closing </body> tag on every page (or in your shared layout/footer template).',
          'Deploy the site and open any page: the chat launcher appears in the bottom corner.',
          'Optional: call window.AWebChatbot.identify({ name, email }) after login to attach the visitor to their account.',
        ],
      };
    case 'wordpress':
      return {
        platform,
        language: 'php',
        snippet: `<?php
/**
 * Plugin Name: AWebChatbot
 * Description: AI chatbot and live chat widget.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) { exit; }
add_action('wp_footer', function () {
    echo '${tag}';
    if (is_user_logged_in()) {
        $u = wp_get_current_user();
        printf(
            '<script>window.addEventListener("awebchatbot:ready",function(){window.AWebChatbot.identify(%s);});</script>',
            wp_json_encode(array('name' => $u->display_name, 'email' => $u->user_email))
        );
    }
});`,
        steps: [
          'Option A (no plugin): Appearance → Theme File Editor → footer.php, paste the HTML snippet before </body>.',
          'Option B (recommended): save the PHP above as wp-content/plugins/awebchatbot/awebchatbot.php, then activate "AWebChatbot" under Plugins.',
          'Logged-in WordPress users are identified automatically by the plugin.',
        ],
      };
    case 'shopify':
      return {
        platform,
        language: 'liquid',
        snippet: `${tag}
{% if customer %}
<script>
  window.addEventListener('awebchatbot:ready', function () {
    window.AWebChatbot.identify({ name: {{ customer.name | json }}, email: {{ customer.email | json }} });
  });
</script>
{% endif %}`,
        steps: [
          'Online Store → Themes → … → Edit code.',
          'Open layout/theme.liquid and paste the snippet just above </body>.',
          'Save. Signed-in Shopify customers are identified automatically.',
        ],
      };
    case 'nextjs':
      return {
        platform,
        language: 'tsx',
        snippet: `// app/layout.tsx (App Router)
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script src="${base}/widget.js" data-key="${key}" strategy="afterInteractive" />
      </body>
    </html>
  );
}`,
        steps: [
          'Add the <Script> tag to app/layout.tsx (App Router) or pages/_app.tsx (Pages Router).',
          'If you use a Content-Security-Policy, allow script-src, connect-src (https and wss) and img-src for ' + base + '.',
          'Deploy (Vercel, Cloudflare Pages via @cloudflare/next-on-pages / OpenNext, or Fly.io).',
        ],
      };
    case 'react':
      return {
        platform,
        language: 'tsx',
        snippet: `// src/ChatWidget.tsx
import { useEffect } from 'react';

export function ChatWidget({ user }: { user?: { name?: string; email?: string } }) {
  useEffect(() => {
    if (document.getElementById('awebchatbot-script')) return;
    const s = document.createElement('script');
    s.id = 'awebchatbot-script';
    s.src = '${base}/widget.js';
    s.async = true;
    s.dataset.key = '${key}';
    document.body.appendChild(s);
  }, []);

  useEffect(() => {
    if (!user) return;
    const identify = () => (window as any).AWebChatbot?.identify(user);
    if ((window as any).AWebChatbot?.ready) identify();
    else window.addEventListener('awebchatbot:ready', identify, { once: true });
  }, [user?.email, user?.name]);

  return null;
}

// Render once near the root: <ChatWidget user={currentUser} />`,
        steps: ['Create src/ChatWidget.tsx with the code above.', 'Render <ChatWidget /> once in your root App component.'],
      };
    case 'nuxt':
      return {
        platform,
        language: 'ts',
        snippet: `// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [{ src: '${base}/widget.js', async: true, 'data-key': '${key}', tagPosition: 'bodyClose' }],
    },
  },
});`,
        steps: ['Add the script entry to nuxt.config.ts under app.head.script.', 'Restart the dev server / redeploy.'],
      };
    case 'cloudflare':
      return {
        platform,
        language: 'html',
        snippet: tag,
        steps: [
          'Any site proxied by Cloudflare (orange cloud) can get the widget with zero code changes. Pick one option:',
          'Option A — Cloudflare Zaraz: Dashboard → your zone → Zaraz → Tools → Add new tool → "Custom HTML", paste the snippet, trigger "Pageview", then Publish.',
          'Option B — HTML injector Worker: deploy integrations/cloudflare-injector from this repo with a route like yourdomain.com/* ; it uses HTMLRewriter to add the snippet to every HTML response.',
          'Option C — Cloudflare Pages / Workers static site: paste the snippet in your layout before </body> and redeploy.',
          'Optional bot protection: create a Turnstile widget for your domain and set turnstileSiteKey in the chatbot settings plus the TURNSTILE_SECRET secret.',
        ],
      };
    case 'gtm':
      return {
        platform,
        language: 'html',
        snippet: `<script>
  (function () {
    var s = document.createElement('script');
    s.src = '${base}/widget.js';
    s.async = true;
    s.setAttribute('data-key', '${key}');
    document.body.appendChild(s);
  })();
</script>`,
        steps: ['Google Tag Manager → Tags → New → Custom HTML, paste the snippet.', 'Trigger: All Pages (or DOM Ready). Submit and publish the container.'],
      };
  }
}
