import { BlurHighlight } from '@/components/ui/blur-highlight';

const sites = [
  {
    domain: 'breachmodal.com',
    text: 'Explains detection, triage and human-approved remediation across AWS, Azure and GCP. Anyone reporting an active incident goes straight to a person.',
    bit: 'goes straight to a person',
  },
  {
    domain: 'isshereal.com',
    text: 'Walks people through checking an influencer, a dating match or a seller, and treats every score as a signal, not proof.',
    bit: 'a signal, not proof',
  },
  {
    domain: 'betmodal.com',
    text: 'Covers 60-second rounds, Gold Coins and Sweepstakes Cash for players 18 and over, and never promises a win.',
    bit: 'never promises a win',
  },
  {
    domain: 'robomodal.com',
    text: 'Answers venue, city and investor questions about supervised robots, and labels every figure as a target.',
    bit: 'labels every figure as a target',
  },
];

const steps = [
  { title: 'Paste one script tag', body: 'Add the snippet before the closing body tag, or let the Cloudflare injector add it with no code change.' },
  { title: 'The assistant reads your pages', body: 'It crawls your sitemap and links, then answers only from what your site actually says.' },
  { title: 'Your team takes the hand-offs', body: 'When a visitor asks for a person, the chat lands in the shared inbox with an AI-drafted reply ready to edit.' },
];

export default function Home() {
  const base = process.env.NEXT_PUBLIC_AWEBCHATBOT_URL?.replace(/\/$/, '') || 'https://awebchatbot.your-subdomain.workers.dev';
  const snippet = `<script src="${base}/widget.js" data-key="pk_…" async></script>`;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <span className="font-display text-xl font-bold tracking-tight">AWebChatbot</span>
        <a
          href={`${base}/inbox/`}
          className="rounded-full border-2 border-ink px-4 py-1.5 text-sm font-semibold transition-colors hover:bg-ink hover:text-paper"
        >
          Open the inbox
        </a>
      </header>

      <main>
        <section className="pt-16 pb-24 sm:pt-28 sm:pb-36" aria-label="What AWebChatbot does">
          <BlurHighlight
            as="h1"
            className="font-display max-w-[19ch] text-[clamp(2.25rem,6vw,4.75rem)] leading-[1.04] font-semibold tracking-[-0.025em]"
            highlightedBits={['answers from your own pages', 'hands the hard ones to your team']}
            highlightColor="var(--marigold)"
            blurAmount={12}
            blurDuration={1.1}
            highlightDelay={0.7}
            highlightDuration={0.9}
            highlightStagger={0.55}
            viewportOptions={{ once: true, amount: 0.3 }}
          >
            One assistant answers from your own pages, day and night, and hands the hard ones to your team.
          </BlurHighlight>
          <p className="mt-10 max-w-[56ch] text-slate">
            An AI chatbot and live chat for four websites, run from one shared inbox. Claude answers first; Gemini, Grok
            and Workers AI step in if it&rsquo;s unavailable.
          </p>
        </section>

        <section className="border-t-2 border-ink py-16" aria-labelledby="sites-heading">
          <h2 id="sites-heading" className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            What it does on each site
          </h2>
          <ul className="mt-10">
            {sites.map((site) => (
              <li key={site.domain} className="grid gap-2 border-b border-rule py-7 sm:grid-cols-[14rem_1fr] sm:gap-8">
                <span className="font-display text-lg font-semibold">{site.domain}</span>
                <BlurHighlight
                  className="max-w-[60ch] text-lg leading-relaxed"
                  highlightedBits={[site.bit]}
                  highlightColor="var(--marigold)"
                  blurAmount={6}
                  inactiveOpacity={0.25}
                  blurDuration={0.6}
                  highlightDelay={0.35}
                  highlightDuration={0.7}
                  viewportOptions={{ once: true, amount: 0.6 }}
                >
                  {site.text}
                </BlurHighlight>
              </li>
            ))}
          </ul>
        </section>

        <section className="py-16" aria-labelledby="steps-heading">
          <h2 id="steps-heading" className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Set up a site in three steps
          </h2>
          <ol className="mt-10 grid gap-10 sm:grid-cols-3">
            {steps.map((step, i) => (
              <li key={step.title}>
                <span className="font-display text-5xl font-bold text-signal">{i + 1}</span>
                <h3 className="mt-3 font-semibold">{step.title}</h3>
                <p className="mt-2 text-slate">{step.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-14 rounded-xl bg-paper-deep p-5 sm:p-6">
            <p className="text-sm font-semibold">The snippet for any page</p>
            <pre className="mt-3 overflow-x-auto text-sm leading-relaxed">
              <code>{snippet}</code>
            </pre>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule py-8 text-sm text-slate">
        Runs on Cloudflare Workers. Conversations stay in your own account.
      </footer>
    </div>
  );
}
