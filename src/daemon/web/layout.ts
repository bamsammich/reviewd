import { html, raw, type SafeHtml } from './html.js'

/**
 * The page shell and the whole stylesheet.
 *
 * Server-rendered with a small script for the interactive parts rather than a
 * client framework. Reviewing happens on a phone on a cell connection, the
 * whole interaction surface is a few forms, and a bundle would cost more than
 * it returns.
 *
 * Colors are tokens defined once per theme, and both themes are defined
 * together so a value cannot exist in one and not the other. Text tokens are
 * chosen to clear 4.5:1 against the surface they sit on.
 */

const STYLE = `
:root {
  color-scheme: light dark;

  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #f0f2f6;
  --ink: #14171d;
  --ink-2: #3c4453;
  --muted: #5b6474;
  --rule: #dde1e8;
  --rule-strong: #c3cad6;
  --accent: #2a4f96;
  --accent-ink: #ffffff;
  --accent-soft: #e7edf9;
  --add-bg: #e8f7ed;
  --add-ink: #216e3c;
  --del-bg: #fdeceb;
  --del-ink: #a3322f;
  --warn-ink: #8a5a12;

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;

  --radius: 10px;
  --tap: 44px;

  /* How far down the page anything sticky has to start, so the app bar does
     not sit on top of it. Declared once because three things need to agree:
     the bar's own height, where a pinned file header parks, and where a
     fragment scrolls its target to. */
  --top-bar: 3.35rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1016;
    --surface: #151a22;
    --surface-2: #1c222c;
    --ink: #e3e8f0;
    --ink-2: #bcc5d3;
    --muted: #93a0b2;
    --rule: #262e3a;
    --rule-strong: #3a4453;
    --accent: #8fb0ea;
    --accent-ink: #0d1016;
    --accent-soft: #1a2434;
    --add-bg: #10241a;
    --add-ink: #63c187;
    --del-bg: #2a1517;
    --del-ink: #e58b85;
    --warn-ink: #d8a95e;
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
}

a { color: var(--accent); }

/* Every interactive thing gets a visible ring. Removing it is the fastest way
   to make an interface unusable by keyboard. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}

.skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--surface); color: var(--ink);
  padding: .6rem 1rem; border: 1px solid var(--accent); border-radius: 0 0 var(--radius) 0;
}
.skip:focus { left: 0; }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}

/* ---------- app bar ---------- */

/* Anything a fragment can point at has to clear the sticky app bar, or the
   browser scrolls it to y=0 and the bar covers its first 53 pixels — which is
   the top of the comment you just wrote. */
.thread, #box, .sourcegroup, details.file {
  scroll-margin-top: calc(var(--top-bar) + .5rem);
}

header.top {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: .6rem;
  padding: .5rem .9rem; background: var(--surface);
  border-bottom: 1px solid var(--rule);
  min-height: var(--top-bar);
}
header.top .home {
  font-weight: 700; font-size: .95rem; color: var(--ink);
  text-decoration: none; flex: 0 0 auto;
  display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0 .15rem;
}
header.top .crumb { color: var(--muted); flex: 0 0 auto; }
header.top .where {
  font-size: .95rem; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0;
}
header.top .rev {
  color: var(--muted); font-size: .8rem; flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

main { padding: .9rem; }

/* ---------- review list ---------- */

.page-title { font-size: 1.25rem; margin: 0 0 .8rem; letter-spacing: -.01em; }

ul.reviews { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
ul.reviews li { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); }
ul.reviews a {
  display: block; padding: .85rem 1rem; text-decoration: none; color: inherit;
  border-radius: var(--radius);
}
ul.reviews .title { font-weight: 600; margin-bottom: .3rem; }
ul.reviews .roots {
  font-family: var(--mono); font-size: .76rem; color: var(--muted);
  display: flex; flex-wrap: wrap; gap: .2rem .7rem; margin-bottom: .35rem;
}

.meta { color: var(--muted); font-size: .82rem; }

.badge {
  display: inline-flex; align-items: center; gap: .25rem;
  padding: .12rem .5rem; border-radius: 999px;
  font-size: .72rem; font-weight: 600; border: 1px solid var(--rule-strong);
  color: var(--muted); white-space: nowrap;
}
.badge.you { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.badge.approved { border-color: var(--add-ink); color: var(--add-ink); }
.badge.draft { border-color: var(--warn-ink); color: var(--warn-ink); }

/* ---------- scope: what is under review ---------- */

.scope { margin: 0 0 .9rem; }
.scope h2 {
  font-size: .74rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0 0 .4rem;
}
.scope ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .1rem; }
.scope .branch + .branch { margin-top: .8rem; }
.scope a.root {
  display: flex; align-items: center; gap: .4rem .5rem; flex-wrap: wrap;
  padding: .45rem .6rem; min-height: var(--tap);
  background: var(--surface); border: 1px solid var(--rule);
  border-left: 3px solid var(--rule-strong);
  border-radius: var(--radius); text-decoration: none; color: inherit;
  margin-bottom: .3rem;
}
.scope a.root.ok { border-left-color: var(--add-ink); }
.scope .vcs { flex: 0 0 auto; color: var(--muted); }
.scope a.root.ok .vcs { color: var(--add-ink); }
.scope .path {
  font-family: var(--mono); font-size: .72rem; color: var(--muted);
  overflow-wrap: anywhere; flex: 1 1 100%;
}
.scope .name {
  font-family: var(--mono); font-weight: 600; font-size: .82rem;
  min-width: 0; overflow-wrap: anywhere;
}

/* A tree shows one segment per node, which is short. The old rail showed whole
   paths, which are the long token that forces either an overflow or a
   truncation hiding the end that names the file. */
.scope .tree { padding-left: .75rem; border-left: 1px solid var(--rule); margin-left: .35rem; }
.scope .tree .tree { margin-left: .1rem; }

.scope .dir > summary {
  display: flex; align-items: center; gap: .35rem;
  padding: .25rem .3rem; border-radius: 6px; cursor: pointer;
  list-style: none; min-height: 1.9rem; color: var(--muted);
}
.scope .dir > summary::-webkit-details-marker { display: none; }
.scope .dir > summary::before {
  content: "\\25be"; font-size: .7rem; flex: 0 0 auto;
}
.scope .dir:not([open]) > summary::before { content: "\\25b8"; }
.scope .dir > summary .name { font-weight: 500; font-size: .78rem; color: var(--ink-2); }
.scope .dir > summary:hover { background: var(--surface-2); }

.scope a.leaf {
  display: flex; align-items: center; gap: .4rem;
  padding: .25rem .3rem; border-radius: 6px; min-height: 1.9rem;
  text-decoration: none; color: inherit;
}
.scope a.leaf:hover { background: var(--surface-2); }
.scope a.leaf .name { font-weight: 400; font-size: .78rem; flex: 1 1 auto; }

/* A letter as well as a colour, so the change type survives being unable to
   tell them apart. */
.scope .mark {
  flex: 0 0 auto; width: 1.05rem; text-align: center;
  font-family: var(--mono); font-size: .68rem; font-weight: 700;
  color: var(--muted);
}
.scope .mark.added { color: var(--add-ink); }
.scope .mark.deleted { color: var(--del-ink); }
.scope .mark.modified { color: var(--warn-ink); }

.scope .count {
  flex: 0 0 auto; font-size: .72rem; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.scope a.leaf .count {
  background: var(--accent-soft); color: var(--accent);
  border-radius: 999px; padding: 0 .35rem; min-width: 1.2rem; text-align: center;
}

/* The file being read. Set by script, so it simply does not appear without
   one, which costs nothing that was not already unavailable. */
.scope a.leaf[aria-current] {
  background: var(--accent-soft); color: var(--accent);
}
.scope a.leaf[aria-current] .name { font-weight: 600; }

/* Above the diff on a narrow screen rather than beside it, so a tree of any
   size would push the code off the bottom. Bounded and given its own scroll,
   which is a nested scroll region and a deliberate one: the alternative is
   scrolling past the whole tree to reach the first line of code. */
@media (max-width: 1023px) {
  .scope { max-height: 45vh; overflow-y: auto; }
}

.hint {
  margin: 0 0 .9rem; padding: .6rem .8rem; border-radius: var(--radius);
  background: var(--accent-soft); color: var(--ink-2);
  border: 1px solid var(--accent); font-size: .85rem;
}
.hint b { color: var(--ink); }
.hint .key {
  font-family: var(--mono); font-weight: 700; color: var(--accent);
  padding: 0 .2rem;
}

/* ---------- files ---------- */

.sourcegroup { margin-bottom: 1.1rem; }
.sourcegroup > h2 {
  font-size: .78rem; font-family: var(--mono); color: var(--muted);
  margin: 0 0 .45rem; font-weight: 600;
  display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap;
}

/* No overflow: hidden here, which is what used to round the corners over the
   diff. A clipping ancestor stops position: sticky working on anything inside
   it, so the clipping moved down to the diff itself and the radius is split
   between the two. */
details.file {
  background: var(--surface); border: 1px solid var(--rule);
  border-radius: var(--radius); margin-bottom: .7rem;
}
details.file > .diff {
  overflow: hidden; border-radius: 0 0 var(--radius) var(--radius);
}

/* The file you are reading stays named while you read it. Pinned under the app
   bar, above the diff but below the two bars that own the edges of the
   screen. */
details.file > summary {
  position: sticky; top: var(--top-bar); z-index: 10;
  padding: .5rem .7rem; cursor: pointer;
  display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;
  background: var(--surface); border-bottom: 1px solid var(--rule);
  border-radius: var(--radius) var(--radius) 0 0;
  min-height: var(--tap); list-style: none;
}

/* Nothing to pin above, and the corners are its own. */
details.file:not([open]) > summary {
  position: static; border-radius: var(--radius); border-bottom: 0;
}
details.file > summary::-webkit-details-marker { display: none; }
details.file > summary::before {
  content: "\\25be"; color: var(--muted); flex: 0 0 auto; font-size: .8rem;
}
details.file:not([open]) > summary::before { content: "\\25b8"; }
details.file > summary h3 {
  font-family: var(--mono); font-size: .84rem; font-weight: 600;
  margin: 0; overflow-wrap: anywhere; min-width: 0;
}

/* ---------- diff ---------- */

/*
 * One markup, two views.
 *
 * Every row carries both halves. Side by side when there is room, stacked when
 * there is not, and the stylesheet decides which without the server ever
 * knowing how wide the screen is. The data-unified attribute says which halves
 * survive the stack, so a context line is not printed twice.
 */

.diff { font-family: var(--mono); font-size: 12.5px; }

.hunkhead {
  background: var(--surface-2); color: var(--muted); font-size: .72rem;
  padding: .3rem .5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.row { display: grid; grid-template-columns: 1fr; }

.side {
  display: grid;
  grid-template-columns: 2.6rem 1.7rem 1rem minmax(0, 1fr);
  align-items: start;
  min-width: 0;
}
.side .n {
  text-align: right; padding: .1rem .4rem; color: var(--muted);
  user-select: none; font-variant-numeric: tabular-nums;
}
.side .act { padding: 0; }
.side .sign { padding: .1rem 0; user-select: none; text-align: center; }
.side .t { padding: .1rem .4rem; white-space: pre-wrap; overflow-wrap: anywhere; }

.side.added { background: var(--add-bg); }
.side.added .sign { color: var(--add-ink); }
.side.removed { background: var(--del-bg); }
.side.removed .sign { color: var(--del-ink); }
.side.empty { background: var(--surface-2); }

/* Stacked by default, which is what a phone gets and what unified means. */
.row[data-unified='right'] > .side.left,
.row[data-unified='left'] > .side.right { display: none; }

/* The comment affordance. Always visible rather than revealed on hover,
   because a phone has no hover and a control nobody can find does not exist. */
a.addnote {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 1.5rem;
  color: var(--muted); text-decoration: none; font-weight: 700; font-size: .95rem;
  border-radius: 4px;
}
a.addnote:hover, a.addnote:focus-visible { background: var(--accent); color: var(--accent-ink); }

/* The lines a comment covers, whether it is saved or still being chosen. A
   left border rather than a background, because added and removed lines
   already own their background and a second one would fight it. */
.side.covered { box-shadow: inset 2px 0 0 var(--accent); }
.side.covered .n { color: var(--ink-2); }

/* Offered on every line below an open comment box, and the path a touch
   screen takes, where a drag is a scroll. */
a.addnote.extend { color: var(--accent); font-weight: 700; }

/* Under the pointer mid-drag. Brighter than the saved shading, because this
   one answers "what am I about to pick" rather than "what does this cover". */
.side.selecting { background: var(--accent-soft); }
.side.selecting .t, .side.selecting .n { color: var(--ink); }

/* The gutter is the drag handle, so it should not look like text to grab. */
.side .n, .side .sign { -webkit-user-select: none; user-select: none; }

/* Coarse pointers get rows tall enough to hit without aiming. */
@media (pointer: coarse) {
  .side .n, .side .t, .side .sign { padding-top: .25rem; padding-bottom: .25rem; }
  a.addnote { min-height: 1.9rem; }
}

/* Hiding the tree matters most on a narrow screen, where it sits above the
   diff rather than beside it, so the row shows at every width. Only the
   side-by-side choice is hidden below the breakpoint, where it is ignored
   anyway. */
.viewtoggle { display: flex; justify-content: flex-end; gap: .4rem; margin-bottom: .6rem; }
.viewtoggle .viewmode { display: none; }

/* Closed: the diff takes the whole width and the tree is gone rather than
   emptied, so nothing keeps a column it is not using. */
main.review.rail-closed > .rail { display: none; }

/* ---------- threads ---------- */

/* The diff cell preserves whitespace so code renders faithfully. A thread cell
   holds markup, and inheriting that turns every newline into blank space. */
tr.threadrow td { padding: 0; background: var(--surface-2); white-space: normal; }

.thread {
  border-left: 3px solid var(--accent); margin: .5rem;
  padding: .65rem .75rem; font-family: var(--sans); font-size: .9rem;
  background: var(--surface); border-radius: 0 var(--radius) var(--radius) 0;
}
.thread.resolved { border-left-color: var(--add-ink); }
.thread.outdated { border-left-color: var(--muted); }
.thread .drift { margin: 0 0 .45rem; color: var(--warn-ink); font-size: .78rem; }
.thread .where { font-family: var(--mono); font-size: .75rem; color: var(--muted); margin: 0 0 .4rem; }
.thread .msg { margin-bottom: .55rem; }
.thread .who {
  font-size: .7rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .05em; color: var(--muted); margin-right: .35rem;
}
/* Markdown builds real blocks now, so pre-wrap would double every gap. Line
   breaks a reader typed survive as <br>, which is the part pre-wrap was for. */
.thread .body { overflow-wrap: anywhere; margin-top: .15rem; }
.thread .body > :first-child { margin-top: 0; }
.thread .body > :last-child { margin-bottom: 0; }
.thread .body p { margin: .4rem 0; }
.thread .body ul, .thread .body ol { margin: .4rem 0; padding-left: 1.3rem; }
.thread .body li { margin: .15rem 0; }
.thread .body code {
  font-family: var(--mono); font-size: .88em;
  background: var(--surface-2); border: 1px solid var(--rule);
  border-radius: 4px; padding: .05em .3em;
}
.thread .body pre.code {
  margin: .45rem 0; padding: .5rem .6rem; overflow-x: auto;
  background: var(--surface-2); border: 1px solid var(--rule); border-radius: 6px;
}
/* The border and background belong to the block, not to every line in it. */
.thread .body pre.code code {
  background: none; border: 0; padding: 0; font-size: .85em; white-space: pre;
}
.thread .body blockquote {
  margin: .45rem 0; padding: .1rem 0 .1rem .7rem;
  border-left: 3px solid var(--rule-strong); color: var(--muted);
}
.thread .body a { color: var(--accent); }
.thread label { display: block; font-size: .78rem; color: var(--muted); margin-bottom: .25rem; }
.thread textarea {
  width: 100%; font: inherit; font-size: 16px; padding: .5rem .6rem;
  border-radius: 8px; border: 1px solid var(--rule-strong);
  background: var(--bg); color: var(--ink); resize: vertical; min-height: 3rem;
}
.thread .actions { display: flex; gap: .5rem; margin-top: .5rem; flex-wrap: wrap; }

/* The reply box starts closed. A thread is usually read, not answered, and an
   open textarea under every one of them reads as work outstanding. */
.thread details.reply > summary {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: .88rem; font-weight: 500; min-height: 2.5rem;
  padding: .45rem .85rem; border-radius: 8px;
  border: 1px solid var(--rule-strong); background: var(--surface);
  color: var(--ink); cursor: pointer; list-style: none; margin-top: .5rem;
}
.thread details.reply > summary::-webkit-details-marker { display: none; }
.thread details.reply[open] > summary { margin-bottom: .5rem; }

/* ---------- controls ---------- */

button, .btn {
  font: inherit; font-size: .88rem; font-weight: 500;
  min-height: 2.5rem; padding: .45rem .85rem; border-radius: 8px;
  border: 1px solid var(--rule-strong); background: var(--surface); color: var(--ink);
  cursor: pointer; text-decoration: none; line-height: 1.2;
  display: inline-flex; align-items: center; justify-content: center; gap: .35rem;
}
button.primary, .btn.primary {
  border-color: var(--accent); background: var(--accent); color: var(--accent-ink);
  font-weight: 600;
}
button.quiet, .btn.quiet { color: var(--muted); border-color: var(--rule); background: transparent; }
button:hover, .btn:hover { border-color: var(--accent); }

/* ---------- comments on the whole change ---------- */

/* Deliberately not a file card. Reusing .file put a thing that is not a file
   in the same visual family as the files, immediately above them. */
.overall { margin: 1rem 0 0; }

.overall-title {
  display: flex; align-items: center; gap: .5rem;
  font-size: .95rem; margin: 0 0 .5rem;
}

.overall .compose {
  background: var(--surface); border: 1px solid var(--rule);
  border-radius: var(--radius);
}
.overall .compose > summary {
  display: flex; align-items: center; gap: .4rem;
  padding: .7rem .9rem; min-height: var(--tap);
  cursor: pointer; list-style: none;
  font-size: .9rem; font-weight: 600; color: var(--accent);
}
.overall .compose > summary::-webkit-details-marker { display: none; }
.overall .compose > summary::before { content: "+"; font-weight: 700; }
.overall .compose[open] > summary::before { content: "\\2212"; }
.overall .compose > summary:hover { background: var(--surface-2); border-radius: var(--radius); }

.overall .compose form { padding: 0 .9rem .9rem; display: grid; gap: .4rem; }

/* A label that is read, not a placeholder standing in for one. The old box
   showed its only guidance inside itself, which vanished on the first keypress
   and was never available to a screen reader as a label at all. */
.overall .compose label { font-size: .85rem; font-weight: 600; color: var(--ink-2); }

/* Full width, and the size and family of prose rather than of a diff. The
   inline reply styling it borrowed made a 183px monospace box in an 858px
   column. 16px is also what stops iOS zooming the page on focus. */
.overall .compose textarea {
  width: 100%; font: inherit; font-size: 16px; font-family: var(--sans);
  padding: .5rem .6rem; min-height: 6rem; resize: vertical;
  color: var(--ink); background: var(--bg);
  border: 1px solid var(--rule-strong); border-radius: 8px;
}

.overall .compose .help { margin: 0; font-size: .8rem; color: var(--muted); }

/* Secondary. Approve is the page's primary action and should stay the only
   thing wearing that weight. */
.overall .compose button {
  justify-self: start; min-height: var(--tap); padding: 0 1rem;
  font: inherit; font-weight: 600; cursor: pointer;
  color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--rule-strong); border-radius: 8px;
}
.overall .compose button:hover { border-color: var(--accent); color: var(--accent); }

/* ---------- submit bar ---------- */

main.with-bar { padding-bottom: 7.5rem; }

.bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
  background: var(--surface); border-top: 1px solid var(--rule);
  padding: .55rem .8rem calc(.55rem + env(safe-area-inset-bottom));
}
.bar .row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.bar .state { font-size: .82rem; color: var(--muted); flex: 1 1 100%; }
.bar .state strong { color: var(--ink); }
.bar .verdicts { display: flex; gap: .5rem; flex: 1 1 auto; }
.bar .verdicts button { flex: 1 1 auto; }

/* Named for the page-level "there is nothing here" message. The old name,
   plain .empty, also matched the blank half of every added or removed line in
   the diff, so padding meant for a lonely paragraph landed on 387 of the 538
   rows in a six-file review and tripled their height side by side. */
.emptystate { color: var(--muted); padding: 2.5rem 1rem; text-align: center; }
.note { color: var(--muted); font-family: var(--mono); font-size: .78rem; padding: .6rem .8rem; }

/* Says an update is held rather than lost, for the one case where the page
   cannot refresh itself: the reviewer is mid-sentence. */
.live-notice {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(var(--bar-height, 4.5rem) + .75rem); z-index: 40;
  background: var(--accent); color: var(--accent-ink);
  font-size: .8rem; padding: .45rem .8rem; border-radius: 999px;
  box-shadow: 0 2px 10px rgb(0 0 0 / .25); max-width: calc(100vw - 2rem);
}

/* How the page is keeping up, when the answer is not "live".

   In the bar rather than floating over the diff. It was a pill like the one
   above, and that was wrong for a different reason than it looked: the pill is
   for something momentary, and this state lasts as long as the reviewer stays
   in a browser that blocks background requests. A permanent overlay is a
   permanent hole in the code you are reading, and moving it around the screen
   only changes which lines it covers. So it stops being an overlay. */
header.top .keeping-up {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: .35rem;
  font-size: .75rem; color: var(--warn-ink, #b98900);
  border: 1px solid currentColor; border-radius: 999px;
  padding: .1rem .2rem .1rem .5rem; max-width: 45vw;
}
header.top .keeping-up .what {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
header.top .keeping-up .refresh,
header.top .keeping-up .dismiss {
  flex: none; background: none; border: 0; color: inherit; cursor: pointer;
  line-height: 1; padding: .15rem .35rem; border-radius: 999px;
}
header.top .keeping-up .refresh {
  font-size: .75rem; font-weight: 600; text-decoration: underline;
  color: inherit; white-space: nowrap;
}
header.top .keeping-up .dismiss { font-size: .9rem; }
header.top .keeping-up .refresh:hover,
header.top .keeping-up .dismiss:hover {
  background: color-mix(in srgb, currentColor 15%, transparent);
}
header.top .keeping-up .refresh:focus-visible,
header.top .keeping-up .dismiss:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }

/* Narrow screens have no room for the sentence, so it keeps the dot and the
   dismiss and drops the words rather than pushing the title off the bar. */
@media (max-width: 30rem) {
  header.top .keeping-up .what { display: none; }
  header.top .keeping-up { padding-left: .35rem; }
}

/* ---------- desktop ---------- */

@media (min-width: 1024px) {
  main { padding: 1.25rem 1.5rem; }

  .viewtoggle .viewmode { display: inline-flex; }

  /* Below this width two columns of code are unreadable, so the preference is
     ignored rather than honored into uselessness. */
  main.view-split .row { grid-template-columns: 1fr 1fr; }

  /* Both halves come back, at a specificity that beats the stacking rules
     above rather than relying on source order. */
  main.view-split .row[data-unified='right'] > .side.left,
  main.view-split .row[data-unified='left'] > .side.right,
  main.view-split .row > .side { display: grid; }
  main.view-split .row > .side.left { border-right: 1px solid var(--rule); }
  main.view-split .side { grid-template-columns: 2.6rem 1.5rem .9rem minmax(0, 1fr); }

  /* Unbounded on purpose. A cap centers the page and turns everything past it
     into margin, which on a wide monitor is 480px a side that lines wrap for
     want of. GitHub's Files tab is uncapped for the same reason; its 1280px cap
     is on the Conversation tab, which is prose. */
  main.review {
    display: grid;
    grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }
  main.review.rail-closed { grid-template-columns: minmax(0, 1fr); }
  /* Sticky and unbounded means a tree taller than the viewport has entries
     nobody can reach: the page scrolls, the rail does not move with it, and
     the bottom of the tree is simply gone. Bounding it to what is left between
     the two bars gives the rail its own scroll. */
  main.review .rail {
    position: sticky;
    top: calc(var(--top-bar) + .5rem);
    max-height: calc(100vh - var(--top-bar) - var(--bar-height, 4.5rem) - 1.5rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: .25rem;
  }
  main.review .files { min-width: 0; }
  main.with-bar { padding-bottom: 5rem; }

  /* The bar spans the window, so its padding is what lines the verdict buttons
     up with the right edge of the diff above them. */
  .bar { padding-left: 1.5rem; padding-right: 1.5rem; }
  .bar .row { flex-wrap: nowrap; }
  .bar .state { flex: 1 1 auto; }
  .bar .verdicts { flex: 0 0 auto; }
  .bar .verdicts button { flex: 0 0 auto; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
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
        <a class="skip" href="#main">Skip to content</a>
        ${body} ${extra}
      </body>
    </html>`
}

/**
 * The app bar.
 *
 * `where` names the thing being looked at rather than repeating the product
 * name, so a reviewer arriving from a notification can tell what they opened
 * without scrolling.
 */
export function topBar(where: string, right: SafeHtml = raw('')): SafeHtml {
  return html`<header class="top">
    <a class="home" href="/">reviewd</a>
    <span class="crumb" aria-hidden="true">/</span>
    <span class="where" title="${where}">${where}</span>
    ${right}
  </header>`
}
