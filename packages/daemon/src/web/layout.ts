import { html, raw, type SafeHtml } from './html.js'

/**
 * The page shell.
 *
 * Server-rendered with a small script for the interactive parts rather than a
 * client framework. Reviewing happens on a phone on a cell connection, the
 * whole interaction surface is a few forms, and a bundle would cost more than
 * it returns.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfc;
  --surface: #fff;
  --ink: #16181d;
  --muted: #626a78;
  --rule: #dfe3e9;
  --accent: #2f5391;
  --add-bg: #e6ffec;
  --add-rule: #74c990;
  --del-bg: #ffebe9;
  --del-rule: #e0868a;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --surface: #151a21; --ink: #dee4ee; --muted: #8b95a5;
    --rule: #262e3a; --accent: #8fade6;
    --add-bg: #12261a; --add-rule: #2f6f43;
    --del-bg: #2b1618; --del-rule: #8c3b40;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
a { color: var(--accent); }
header.top {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
  padding: .65rem 1rem; background: var(--surface);
  border-bottom: 1px solid var(--rule);
}
header.top h1 { font-size: 1rem; margin: 0; font-weight: 600; }
header.top .spacer { flex: 1 1 auto; }
.meta { color: var(--muted); font-size: .82rem; }
main { padding: 1rem; max-width: 100%; }

.badge {
  display: inline-block; padding: .1rem .45rem; border-radius: 999px;
  font-size: .72rem; font-weight: 600; border: 1px solid var(--rule);
  color: var(--muted);
}
.badge.you { border-color: var(--accent); color: var(--accent); }
.badge.approved { border-color: var(--add-rule); color: var(--add-rule); }

ul.reviews { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
ul.reviews li {
  background: var(--surface); border: 1px solid var(--rule); border-radius: 8px;
}
ul.reviews a { display: block; padding: .8rem 1rem; text-decoration: none; color: inherit; }
ul.reviews .title { font-weight: 600; margin-bottom: .2rem; }

details.file {
  background: var(--surface); border: 1px solid var(--rule);
  border-radius: 8px; margin-bottom: .8rem; overflow: hidden;
}
details.file > summary {
  padding: .6rem .8rem; cursor: pointer; font-family: var(--mono);
  font-size: .8rem; display: flex; gap: .5rem; align-items: center;
  background: var(--surface);
  border-bottom: 1px solid var(--rule);
  /* Not sticky: a sticky summary inside a rounded, clipped details element
     reserves space above itself and hides the first row of the diff. */
  /* The default marker lays out as its own block and leaves a bar above the
     filename once the summary is a flex container. */
  list-style: none;
}
details.file > summary::-webkit-details-marker { display: none; }
details.file > summary::before {
  content: "\\25be"; color: var(--muted); flex: 0 0 auto;
  transition: transform .12s ease;
}
details.file:not([open]) > summary::before { transform: rotate(-90deg); }
@media (prefers-reduced-motion: reduce) {
  details.file > summary::before { transition: none; }
}
details.file > summary .path { overflow-wrap: anywhere; }
details.file > summary .src { color: var(--muted); }

table.diff { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12.5px; }
table.diff td { padding: 0 .4rem; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
table.diff td.num {
  width: 1%; min-width: 2.2rem; text-align: right; color: var(--muted);
  user-select: none; border-right: 1px solid var(--rule); white-space: nowrap;
}
table.diff tr.added td { background: var(--add-bg); }
table.diff tr.removed td { background: var(--del-bg); }
table.diff tr.added td.sign { color: var(--add-rule); }
table.diff tr.removed td.sign { color: var(--del-rule); }
table.diff td.sign { width: 1%; user-select: none; padding: 0 .2rem; }
table.diff tr.hunk td { background: var(--bg); color: var(--muted); font-size: .75rem; padding: .3rem .5rem; white-space: nowrap; }
table.diff tr.code { cursor: pointer; }
table.diff tr.code:hover td.num { color: var(--accent); }

.empty { color: var(--muted); padding: 2rem 1rem; text-align: center; }
.note { color: var(--muted); font-family: var(--mono); font-size: .78rem; padding: .5rem .8rem; }

/* ---------- sources, threads, tray ---------- */

.sources { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .9rem; }
.sources .source {
  display: inline-flex; align-items: baseline; gap: .4rem; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--rule); border-radius: 6px;
  padding: .35rem .6rem; font-size: .78rem;
}
.sources .source.ok { border-color: var(--add-rule); }
.sources .label { font-weight: 600; font-family: var(--mono); }
.sources .root { color: var(--muted); font-family: var(--mono); font-size: .72rem; overflow-wrap: anywhere; }

.callout {
  margin: 0 0 .9rem; padding: .55rem .8rem; font-size: .85rem;
  background: var(--surface); border: 1px solid var(--accent); border-radius: 6px;
}

table.diff td .rowlink { color: inherit; text-decoration: none; display: block; }

/* The diff cell preserves whitespace so code renders faithfully. A thread cell
   holds markup, and inheriting that turns every newline in the template into
   blank space. */
tr.threadrow td { padding: 0; background: var(--bg); white-space: normal; }
.thread {
  border-left: 3px solid var(--accent); margin: .4rem;
  padding: .6rem .7rem; font-family: var(--sans); font-size: .88rem;
  background: var(--surface); border-radius: 0 6px 6px 0;
}
.thread.resolved { border-left-color: var(--add-rule); opacity: .75; }
.thread.outdated { border-left-color: var(--muted); opacity: .75; }
.thread .drift { margin: 0 0 .4rem; color: var(--muted); font-size: .78rem; }
.thread .msg { margin-bottom: .5rem; }
.thread .who {
  font-size: .72rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: .04em; color: var(--muted); margin-right: .35rem;
}
.thread .body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: .15rem; }
.thread textarea {
  width: 100%; font: inherit; padding: .45rem .55rem; border-radius: 6px;
  border: 1px solid var(--rule); background: var(--bg); color: var(--ink);
  resize: vertical;
}
.thread .actions { display: flex; gap: .5rem; margin-top: .45rem; align-items: center; }

button, .ghost {
  font: inherit; font-size: .85rem; padding: .4rem .75rem; border-radius: 6px;
  border: 1px solid var(--rule); background: var(--surface); color: var(--ink);
  cursor: pointer; text-decoration: none; line-height: 1.2;
}
button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
button.ghost, a.ghost { color: var(--muted); }
button:hover, .ghost:hover { border-color: var(--accent); }

main.with-tray { padding-bottom: 5.5rem; }
form.tray {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
  display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  padding: .6rem .8rem calc(.6rem + env(safe-area-inset-bottom));
  background: var(--surface); border-top: 1px solid var(--rule);
}
form.tray .count { font-size: .82rem; color: var(--muted); }
form.tray .spacer { flex: 1 1 auto; }

details.file.outdated > summary .src { font-family: var(--sans); }

@media (min-width: 900px) {
  main { padding: 1.25rem 1.75rem; }
  body { font-size: 15.5px; }
}
`

export function page(title: string, body: SafeHtml, extra: SafeHtml = raw('')): SafeHtml {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title}</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        ${body} ${extra}
      </body>
    </html>`
}

export function topBar(title: string, right: SafeHtml = raw('')): SafeHtml {
  return html`<header class="top">
    <h1><a href="/" style="text-decoration:none;color:inherit">reviewd</a></h1>
    <span class="meta">${title}</span>
    <span class="spacer"></span>
    ${right}
  </header>`
}
