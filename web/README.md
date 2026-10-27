# AWebChatbot landing page (Next.js)

A one-page site for AWebChatbot, built with Next.js 16, React 19, Tailwind CSS 4 and shadcn conventions
(`components.json`, `@/components/ui`, `@/lib/utils`).

## Blur Highlight

`components/ui/blur-highlight.tsx` is a paragraph that blurs into focus when scrolled into view, then sweeps a
highlighter across key phrases. It was written for this project with no license key and no dependencies, and it
follows the props documented for React Bits Pro's "Blur Highlight" (`highlightedBits`, `highlightColor`,
`blurAmount`, `inactiveOpacity`, `blurDelay`, `blurDuration`, `highlightDelay`, `highlightDuration`,
`highlightDirection`, `viewportOptions`, `className`, `highlightClassName`). It adds two props of its own:
`highlightStagger` (seconds between successive highlights) and `as` (the element to render).

```tsx
<BlurHighlight
  highlightedBits={['answers from your own pages', { text: 'team', occurrence: 1 }]}
  highlightColor="var(--marigold)"
  viewportOptions={{ once: true, amount: 0.3 }}
>
  One assistant answers from your own pages, and hands the hard ones to your team.
</BlurHighlight>
```

Highlights wrap across lines (a background sweep with `box-decoration-break: clone`). The component also respects
`prefers-reduced-motion`.

## Run

```bash
npm install
cp .env.example .env.local   # optional: loads the live chat widget on the page
npm run dev                  # http://localhost:3000
npm run build && npm start
```

Deploy on Cloudflare (OpenNext), Vercel or Fly.io.
