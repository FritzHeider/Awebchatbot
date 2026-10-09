/**
 * Zero-code install for any site proxied by Cloudflare: this Worker runs on your site's route,
 * fetches the original page and injects the AWebChatbot widget before </body> with HTMLRewriter.
 */
interface Env {
  WIDGET_SRC: string; // e.g. https://awebchatbot.you.workers.dev/widget.js
  WIDGET_KEY: string; // pk_... from get_widget_install_code
  EXCLUDE_PATHS?: string; // comma separated path prefixes, e.g. "/admin,/checkout"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await fetch(request);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') || request.method !== 'GET') return response;

    const path = new URL(request.url).pathname;
    const excluded = (env.EXCLUDE_PATHS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (excluded.some((prefix) => path.startsWith(prefix))) return response;

    const src = env.WIDGET_SRC.replace(/"/g, '');
    const key = env.WIDGET_KEY.replace(/"/g, '');
    let alreadyInstalled = false;

    return new HTMLRewriter()
      .on('script[src*="widget.js"][data-key]', {
        element() {
          alreadyInstalled = true;
        },
      })
      .on('body', {
        element(body) {
          body.onEndTag((end) => {
            if (!alreadyInstalled) end.before(`<script src="${src}" data-key="${key}" async></script>`, { html: true });
          });
        },
      })
      .transform(response);
  },
} satisfies ExportedHandler<Env>;
