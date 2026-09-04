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

  /* A deeper tint of each row colour, for the words that changed inside a
     changed line. The darkest each can go while keyword red stays as legible
     on it as the red family allows. */
  --add-mark: #c9edd3;
  --del-mark: #fcd8d0;

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;

  --radius: 10px;
  --tap: 44px;

  /* How far down the page anything sticky has to start, so the app bar does
     not sit on top of it. Declared once because four things need to agree: the
     bar's own height, where the file rail parks, where a pinned file header
     parks, and where a fragment scrolls its target to.

     Built from what the bar is made of rather than picked to look about right.
     A hand-chosen 3.35rem was 48px at a 0.9 font scale while the bar drew 59,
     because the bar holds a 44px control with a half-rem of padding either side
     and a rule under it; everything parking against the smaller number tucked
     eleven pixels beneath the bar. The tap target is a fixed 44px and the
     padding is relative, so this stays true at any font scale. */
  --top-bar: calc(var(--tap) + 1rem + 1px);
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

    --add-mark: #1d4630;
    --del-mark: #5c2a2d;
  }
}

* { box-sizing: border-box; }

/* Everything here is sized in rem, so the root is the one place a reader's own
   text size and a configured scale meet. A config that sets a scale writes one
   more declaration after this stylesheet. */
html { -webkit-text-size-adjust: 100%; font-size: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  /* Relative, or the root would scale everything except the text. */
  font-size: 1rem;
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
/* A source approving cannot unlock. Quiet rather than alarming: nothing is
   wrong, the review simply covers part of a repository and the gate asks about
   the whole of one. */
.branch .badge.nogate { color: var(--muted); border-color: var(--rule); }

.badge.approved { border-color: var(--add-ink); color: var(--add-ink); }
.badge.draft { border-color: var(--warn-ink); color: var(--warn-ink); }

/* ---------- how big a change is ---------- */

/* Monospaced and tabular so a column of these lines up, which is the whole
   point of putting one on every file in the rail. No shell around it: the two
   grounds a badge could take, --add-bg and --del-bg, already mean "this line
   was added" one row further down the page. */
.tally {
  display: inline-flex; align-items: center; gap: .35rem;
  font-family: var(--mono); font-size: .74rem;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.tally .plus { color: var(--add-ink); }
.tally .minus { color: var(--del-ink); }

/* The ratio, not the size. A four-line file and a four-hundred-line one draw
   the same bar, which is why the numbers stay beside it. */
.propbar {
  display: inline-flex; width: 2.6rem; height: 5px;
  border-radius: 999px; overflow: hidden; flex: 0 0 auto;
}
.propbar i { display: block; height: 100%; }
.propbar .a { background: var(--add-ink); }
.propbar .d { background: var(--del-ink); flex: 1; }

/* ---------- scope: what is under review ---------- */

.scope { margin: 0 0 .9rem; }
.scope h2 {
  font-size: .74rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0;
}

/* The heading and the tools that act on what it counts. The control that hides
   all of it is in the app bar, where the control that brings it back is: one
   button in one place, rather than a button that vanishes with the thing it
   closed and a different one somewhere else. */
.scopehead {
  display: grid; grid-template-columns: minmax(0, 1fr);
  gap: .4rem .5rem; align-items: center; margin-bottom: .5rem;
}
.scopetools { grid-column: 1 / -1; display: flex; gap: .35rem; align-items: center; }

/* type=search, so the browser draws its own clear button and Escape behaves
   the way it does in every other search field. */
.scope .filter {
  flex: 1 1 auto; min-width: 0;
  font: inherit; font-size: 16px; font-family: var(--sans);
  padding: .35rem .55rem; min-height: 2.25rem;
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--rule-strong); border-radius: 8px;
}
.scope .filter::placeholder { color: var(--muted); }
.scope .filter:focus-visible { border-color: var(--accent); }

.scope .foldall {
  flex: 0 0 auto; font: inherit; font-size: .74rem;
  min-height: 2.25rem; padding: 0 .5rem;
  color: var(--muted); background: transparent;
  border: 1px solid var(--rule); border-radius: 8px; cursor: pointer;
}
.scope .foldall:hover { border-color: var(--accent); color: var(--accent); }

/* What a filter leaves behind: matches grouped under the directory holding
   them, flat, with no chain of one-child directories in between. */
.scope ul.matches { list-style: none; margin: 0; padding: 0; display: grid; gap: .1rem; }
.scope .matchdir {
  font-family: var(--mono); font-size: .7rem; color: var(--muted);
  padding: .45rem .3rem .15rem; overflow-wrap: anywhere;
}
.scope .matchdir:first-child { padding-top: .1rem; }
.scope ul.matches a.leaf { padding-left: .55rem; }

.scope .nomatch {
  margin: 0; padding: .8rem .3rem; color: var(--muted); font-size: .8rem;
}
.scope ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .1rem; }
.scope .branch + .branch { margin-top: .8rem; }
/* One line. It was two, because the path wrapped below the name, and the
   second row bought nothing the name did not already say. */
.scope a.root {
  display: flex; align-items: center; gap: .5rem; flex-wrap: nowrap;
  padding: .3rem .5rem; min-height: 2rem;
  background: var(--surface); border: 1px solid var(--rule);
  border-left: 3px solid var(--rule-strong);
  border-radius: 8px; text-decoration: none; color: inherit;
  margin-bottom: .3rem;
}
.scope a.root.ok { border-left-color: var(--add-ink); }
.scope .vcs { flex: 0 0 auto; color: var(--muted); }
.scope a.root.ok .vcs { color: var(--add-ink); }
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

/* The name gives way before the size does. A rail wide enough for both shows
   both; narrower than that, a truncated filename still identifies the file,
   while a wrapped row costs a line on every entry in the list. */
.scope a.leaf .name {
  font-weight: 400; font-size: .78rem;
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* A column, not a trailing decoration.
   Sizes are read down the rail rather than one at a time, and a row where a
   file carries a comment badge pushed its numbers left of the row above it.
   Each half gets a slot wide enough for three digits and right-aligns inside
   it, so +39 sits under +105 and −1 under −15. A fourth digit widens that
   row's slot rather than truncating, which loses the column on the one file
   large enough to have earned attention anyway. */
.scope a.leaf .tally { flex: 0 0 auto; font-size: .7rem; margin-left: auto; }
.scope a.leaf .tally .plus,
.scope a.leaf .tally .minus { min-width: 4ch; text-align: right; }

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
   scrolling past the whole tree to reach the first line of code.

   Measured on a 760px viewport before this: the title, the source card, the
   tree and the hint filled the screen and the submit bar cut the hint off
   mid-sentence. A reviewer opening a review on a phone saw no code at all. */
/* A line of counts that stays put while the diff scrolls under it.
   Drawn only where the rail moves under the diff; above that breakpoint the
   rail is beside the code and nothing needs jumping to. */
.navstrip { display: none; }

@media (max-width: 1023px) {
  /* The rail stacks above the diff by default, which put a commit list, a file
     tree and a hint on the first screen of a phone and no code at all: the
     first row of diff measured 818px down a 699px screen. Order puts the code
     first and the navigation after it, and the strip keeps that navigation one
     tap away rather than one long scroll. */
  main.review {
    display: flex; flex-direction: column;
  }
  main.review > .files { order: 1; }
  main.review > .rail {
    order: 2; margin-top: 1rem; padding-top: .75rem; border-top: 1px solid var(--rule);
  }

  .navstrip {
    position: sticky; top: var(--top-bar); z-index: 5;
    display: flex; align-items: center; gap: .55rem;
    margin: 0 0 .6rem; padding: .5rem .7rem;
    background: var(--surface); border-bottom: 1px solid var(--rule);
    font-size: .8rem; min-height: var(--tap);
  }
  .navstrip a { color: var(--accent); text-decoration: none; }
  .navstrip a:hover { text-decoration: underline; }
  .navstrip .sep { color: var(--muted); }
}

@media (max-width: 1023px) {
  .scope { max-height: 34vh; overflow-y: auto; }

  /* Not capped and not scrolled: the disclosure already bounds the list, and a
     cut-off entry under a heading reads as damage rather than as more below.
     The disclosure itself is a target too, and a thumb finds it the same way
     it finds the entries below. */
  .commentindex a,
  .commentindex > summary { min-height: 2.75rem; }

}

.hint {
  margin: 0 0 .9rem; padding: .6rem .8rem; border-radius: var(--radius);
  background: var(--accent-soft); color: var(--ink-2);
  border: 1px solid var(--accent); font-size: .85rem;
}
.hint b { color: var(--ink); }
.hint .key {
  color: var(--accent); padding: 0 .1rem;
  display: inline-flex; align-items: center; vertical-align: -.15em;
}

/* ---------- where the comments are ---------- */

/*
 * Every open thread, and how to reach it.
 *
 * The page could count comments and could not take you to one. A tally sat on
 * each file in the tree, the bar said "reply above", and the threads were
 * wherever their code was: in a fifteen-file review measured here, at 5,000,
 * 13,000 and 33,600 pixels down a page 34,000 tall. A comment on the change as
 * a whole had no file to be counted against and appeared nowhere at all.
 */
/* The app bar shows this exact string and keeps showing it while you scroll,
   so the rail repeating it spends 93 pixels restating its own header. Kept in
   the document for the outline and for a screen reader, which is what an h1 is
   for, and hidden at every width rather than only on a phone: the rule used to
   live inside a max-width query, which hid it where the app bar was the only
   copy and showed it where there were two. */
main.review > .rail > .page-title {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}

/* ---------- commits ---------- */

/* Above the files, because a commit is picked before a file is and a chosen
   commit shortens the tree underneath it. A disclosure, so a twenty-commit
   push costs one row until somebody wants the list, and open while a commit is
   being read. The shape follows the comment index deliberately: two lists in
   one column that behave differently are two things to learn. */
.commits { margin: 0 0 .7rem; }
.commits > summary {
  font-size: .74rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: .4rem; flex-wrap: wrap;
  min-height: 2.25rem;
}
.commits > summary::-webkit-details-marker { display: none; }
.commits > summary::before { content: "\\25b8"; font-size: .65rem; }
.commits[open] > summary::before { content: "\\25be"; }
.commits > summary:hover { color: var(--accent); }
.commits > summary .badge { text-transform: none; letter-spacing: 0; }
.commits[open] > summary { margin-bottom: .4rem; }
/* An explicit minmax column, and li that may shrink. A grid column defaults to
   auto, which sizes to max-content: the longest commit subject then set the
   width of the list, the rows ran past the right edge of the rail, and the
   ellipsis on each subject never had a reason to fire. */
.commits ul {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: .25rem;
}
.commits li { min-width: 0; }

/* One line each, the shape the file rows below already use: an identifier on
   the left, the subject taking what is left, a number on the right. A card per
   commit was a third taller per row and drew a box around every entry in a
   list whose entries are all the same kind of thing. */
.commits .crow {
  display: flex; align-items: center; gap: .4rem;
  padding: .25rem .3rem; border-radius: 6px; min-height: 1.9rem;
  text-decoration: none; color: inherit;
}
.commits .crow:hover { background: var(--surface-2); }
/* Marked by more than colour: aria-current carries it to a screen reader, and
   the subject takes the accent as well as the ground. */
.commits .crow.on { background: var(--accent-soft); color: var(--accent); }
/* Every sha is seven characters of a monospaced face, so the subjects line up
   without a width being declared. The entry for the whole change carries no
   sha and starts where the shas do, rather than holding a gap open for an
   identifier it will never have. */
.commits .crow .sha {
  font-family: var(--mono); font-size: .68rem; color: var(--muted); flex: 0 0 auto;
}
.commits .crow.on .sha { color: var(--accent); }
.commits .crow .subj {
  font-size: .78rem; flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.commits .crow.on .subj { font-weight: 500; }
/* Which repository the run under it came from, drawn only where a review has
   commits from more than one. Named like the file tree's own source headings,
   because it answers the same question a few rows further down. */
.commits .place {
  font-size: .68rem; letter-spacing: .07em; text-transform: uppercase;
  color: var(--muted); padding: .45rem .3rem .15rem;
  border-top: 1px solid var(--rule); margin-top: .25rem;
}
.commits ul > .place:first-of-type { border-top: 0; margin-top: 0; }

/* A column that is always there, holding a tick or holding nothing, so the
   shas beside it stay in one line however much of the change is covered. */
.commits .crow .tick {
  flex: 0 0 auto; width: .85rem; text-align: center;
  font-size: .72rem; line-height: 1; color: transparent;
}
.commits .crow .tick.yes { color: var(--add-ink); }
.commits .crow.on .tick.yes { color: var(--add-ink); }

/* Right-aligned like the file tallies a few rows down, and in the same column
   whichever entry it belongs to. */
.commits .crow .n {
  font-family: var(--mono); font-size: .68rem; color: var(--muted);
  flex: 0 0 auto; margin-left: auto;
}

/* How much of the change is covered, where GitHub puts its viewed count. */
.commits > summary .cov {
  font-family: var(--mono); font-size: .68rem; color: var(--add-ink);
  margin-left: auto; flex: 0 0 auto;
}

/* What the revision is a reading of. Quiet, because it is orientation rather
   than news, and above everything it orients. */
.reading {
  margin: 0 0 .7rem; padding: .45rem .7rem;
  border-left: 3px solid var(--rule-strong); color: var(--muted); font-size: .84rem;
}

/* The copy that survives the drawer closing, above the diff it describes. */
.readingcommit {
  display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
  padding: .6rem .75rem; margin: 0 0 .8rem;
  border: 1px solid var(--rule); border-left: 3px solid var(--accent);
  border-radius: var(--radius); background: var(--surface);
}
.readingcommit .who { flex: 1 1 14rem; min-width: 0; }
.readingcommit .subj { display: block; font-weight: 600; font-size: .92rem; }
.readingcommit .cmeta { font-size: .78rem; color: var(--muted); }
.readingcommit .sha { font-family: var(--mono); }
.readingcommit .note { margin: 0; font-size: .78rem; color: var(--muted); flex: 0 1 auto; }

/* Below the tree now, which is what makes it a disclosure: open when a thread
   is waiting on the reader, closed when the list is reference. */
.commentindex { margin: .9rem 0 0; }
.commentindex > summary {
  font-size: .74rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: .4rem; flex-wrap: wrap;
  min-height: 2.25rem;
}
.commentindex > summary::-webkit-details-marker { display: none; }
.commentindex > summary::before { content: "\\25b8"; font-size: .65rem; }
.commentindex[open] > summary::before { content: "\\25be"; }
.commentindex > summary:hover { color: var(--accent); }
.commentindex > summary .badge { text-transform: none; letter-spacing: 0; }
.commentindex[open] > summary { margin-bottom: .4rem; }
.commentindex ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
/* Which commit a comment is on, said only when it is somewhere other than the
   view being read. */
.commentindex .oncommit { font-family: var(--mono); color: var(--muted); font-weight: 400; }
.commentindex a {
  display: grid; gap: 0; align-content: center;
  padding: .3rem .55rem; min-height: 2.6rem;
  border: 1px solid var(--rule); border-radius: 8px;
  background: var(--surface); text-decoration: none; color: inherit;
}
.commentindex a:hover { border-color: var(--accent); }

/* The entries past the sixth. A count rather than a chevron and a word,
   because the number is the thing worth knowing before opening it. */
.commentindex details.more > summary {
  list-style: none; cursor: pointer;
  font-size: .76rem; color: var(--muted);
  padding: .4rem .55rem; min-height: 2.2rem;
  display: flex; align-items: center; gap: .3rem;
  border-radius: 8px;
}
.commentindex details.more > summary::-webkit-details-marker { display: none; }
.commentindex details.more > summary::before { content: "\\25b8"; font-size: .65rem; }
.commentindex details.more[open] > summary::before { content: "\\25be"; }
.commentindex details.more > summary:hover { background: var(--surface-2); color: var(--ink-2); }
.commentindex details.more > ul { margin-top: .25rem; }

/* The ones owed an answer carry the accent. The rest are reference. */
.commentindex a.owed { border-color: var(--accent); background: var(--accent-soft); }
.commentindex .where {
  font-size: .74rem; color: var(--muted); overflow-wrap: anywhere;
}
.commentindex .where.at { font-family: var(--mono); }
.commentindex a.owed .where { color: var(--accent); }

/* One line of the comment itself. A location alone makes the reader open each
   one to find out which is which; a second line of it costs 27px per entry and
   pushes the file tree out of the rail. */
.commentindex .gist {
  font-size: .76rem; color: var(--ink-2); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;
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

/* The size goes to the far edge, away from the path and the badges.
   Left in source order it landed in a run of four things pressed together,
   where a number reads as one more badge. Against the right edge it is the
   only thing there, and the same distance from the path on every file. */
details.file > summary .tally { margin-left: auto; }

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

/* Eight columns per tab is the browser default and a diff column is the last
   place that fits. Four, and the server counts the same four when it works out
   how far a wrapped line hangs. */
/* break-word, not anywhere: a token breaks only once it cannot fit on a line
   of its own, which is what GitHub's diff cells use. pre-wrap stays, because
   this renderer emits the line's own leading whitespace as text rather than as
   markup, and normal white-space would collapse the indentation away. */
.side .t {
  padding: .1rem .4rem; white-space: pre-wrap; overflow-wrap: break-word;
  tab-size: 4;
}

/* A wrapped line keeps the shape of the code it came from.
 *
 * Continuation rows used to start at column zero, which on nested code put the
 * second half of a statement to the left of the statement that opened it. The
 * server measures each line's own leading whitespace into --hang; the negative
 * text-indent pulls the first row back out to where it belongs, and every row
 * after it lands two columns inside the code. */
.side .t[style*="--hang"] {
  padding-left: calc(.4rem + var(--hang));
  text-indent: calc(-1 * var(--hang));
}

.side.added { background: var(--add-bg); }
.side.added .sign { color: var(--add-ink); }
.side.removed { background: var(--del-bg); }
.side.removed .sign { color: var(--del-ink); }
.side.empty { background: var(--surface-2); }

/* The words that actually changed, against the words that only moved.
 *
 * A deeper tint of the row's own colour, so the mark reads as more of what the
 * row already says rather than as a third state. The <mark> element brings a
 * yellow ground and a black foreground of its own, and both go: the colour
 * here belongs to the diff, and the text keeps whatever colour the highlighter
 * gave it.
 *
 * Known cost, decided rather than overlooked. Keyword red on the removed tint
 * measures 4.05:1 in light and 4.57:1 in dark, against the 4.5:1 this
 * stylesheet holds everywhere else. No tint in the red family clears both that
 * floor and enough separation from --del-bg to read as a mark, so light loses
 * the floor on one of six syntax colours. Every other colour on either tint
 * clears 10:1. */
.side .word {
  background: none; color: inherit;
  border-radius: 2px; padding: 0 1px;
}
.side.added .word { background: var(--add-mark); }
.side.removed .word { background: var(--del-mark); }

/* Stacked by default, which is what a phone gets and what unified means. */
.row[data-unified='right'] > .side.left,
.row[data-unified='left'] > .side.right { display: none; }


/* The comment affordance.
 *
 * A drawn icon rather than a character. This was a plus sign, sitting one
 * column from the plus that means "added line" and one column from the minus
 * that means "removed": the control the page exists for, wearing the
 * notation's clothes and contradicting it on half the rows.
 *
 * Visible on every line by default, revealed per row where a pointer can
 * hover. GitHub reveals on hover and is right to for a mouse; the same
 * stylesheet on a phone is why commenting on a line from GitHub's mobile web
 * is something people give up on, and a phone is the case reviewd is for.
 * The question is not which of the two is correct, it is which device is
 * asking, and a media query knows.
 */
a.addnote {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 1.5rem;
  color: var(--muted); text-decoration: none;
  border-radius: 4px;

  /* A bubble is a denser mark than the character it replaced, and on a touch
     screen there is one on every line with no hover to thin them out. Held
     back far enough that the column reads as gutter rather than as content,
     and no further: still 3.5:1 against the surface. */
  opacity: .65;
}
a.addnote svg { display: block; }

/* A pointer that can hover gets GitHub's gutter: empty until you are on a row.
   Opacity rather than display, so the control keeps its place in the layout
   and in the tab order, and a keyboard still finds it below. */
/* The row rule deliberately skips the control the pointer is actually on.
   Without :not(:hover) it wins on specificity, 0-3-1 against 0-2-1, and paints
   --ink-2 over the --accent-ink the filled state below sets: a pale icon on a
   pale blue button, 1.3:1 in dark mode, right at the moment the control is
   being pressed. */
@media (hover: hover) and (pointer: fine) {
  a.addnote { opacity: 0; }
  .side:hover a.addnote:not(:hover) { opacity: 1; color: var(--ink-2); }
}

/* Focus outranks both. A control revealed only by a pointer would otherwise be
   invisible to the keyboard that is on it. */
a.addnote:hover, a.addnote:focus-visible {
  background: var(--accent); color: var(--accent-ink); opacity: 1;
}

/* The lines a comment covers, whether it is saved or still being chosen. A
   left border rather than a background, because added and removed lines
   already own their background and a second one would fight it. */
.side.covered { box-shadow: inset 2px 0 0 var(--accent); }
.side.covered .n { color: var(--ink-2); }

/* Offered on every line below an open comment box, and the path a touch
   screen takes, where a drag is a scroll. */
a.addnote.extend { color: var(--accent); opacity: 1; }

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
   diff rather than beside it, so the row shows at every width. The two choices
   that only mean something on a wide screen, side-by-side and wrapping, are
   hidden below the breakpoint, where both are ignored anyway. */
/* The diff controls, in the bar rather than above the first file.
 *
 * The view switch stays hidden until the screen is wide enough for two
 * columns, because below that width the stylesheet stacks every row into
 * unified and the switch would offer a choice the layout has already made. */
header.top .barcontrols { display: flex; align-items: center; gap: .4rem; flex: 0 0 auto; }
header.top .barcontrols .viewmode { display: none; }

/* One control for the drawer, drawn the same way whichever direction it points,
   so pressing it never moves it. Square, because an icon on its own still needs
   the tap target the words used to give it. */
.drawertoggle {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--tap); height: var(--tap); padding: 0;
  color: var(--muted); flex: 0 0 auto;
}
.drawertoggle:hover { color: var(--accent); border-color: var(--accent); }
/* Pressed while the files are showing, which is the state the icon cannot
   express on its own: the same glyph means both "this is open" and "open it". */
.drawertoggle[aria-expanded='true'] {
  color: var(--ink-2); border-color: var(--rule-strong); background: var(--surface-2);
}

/* The size of the whole change, at the end of the bar the drawer cannot hide.
 *
 * Narrow screens keep the numbers and drop the proportion bar. Measured at
 * 375px, the numbers and the bar together take 82 pixels out of the title,
 * which is the review's only name on the page: the h1 in the rail is hidden
 * because this bar already carries it. The bar is the half that can go, since
 * it says a ratio the two numbers beside it already state exactly. */
header.top .wholechange { flex: 0 0 auto; display: inline-flex; }
header.top .wholechange .propbar { display: none; }

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
/* When it was written. A thread carried no time at all, so a reply from four
   days ago and one from four minutes ago read identically. */
.thread .when {
  font-size: .7rem; color: var(--muted); margin-right: .35rem;
  font-variant-numeric: tabular-nums;
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

/* A heading inside a comment, sized as emphasis rather than as structure. The
   page's own headings carry the document; these only separate the parts of one
   note, so they are the body's weight with more space above than below. */
.thread .body .ch {
  font-size: .92rem; font-weight: 600; color: var(--ink);
  margin: .7rem 0 .2rem; line-height: 1.35;
}
.thread .body > .ch:first-child { margin-top: 0; }

/* A table, which arrives whenever a comment compares things. Scrolls inside
   its own box, because a wide one in a narrow thread would otherwise push the
   diff sideways. */
.thread .body table {
  display: block; width: max-content; max-width: 100%; overflow-x: auto;
  border-collapse: collapse; margin: .5rem 0; font-size: .88rem;
}
.thread .body th, .thread .body td {
  border: 1px solid var(--rule); padding: .25rem .5rem; text-align: left;
  vertical-align: top;
}
.thread .body th { background: var(--surface-2); font-weight: 600; }
.thread label { display: block; font-size: .78rem; color: var(--muted); margin-bottom: .25rem; }
.thread textarea {
  width: 100%; font: inherit; font-size: 16px; padding: .5rem .6rem;
  border-radius: 8px; border: 1px solid var(--rule-strong);
  background: var(--bg); color: var(--ink); resize: vertical; min-height: 3rem;
}
.thread .actions { display: flex; gap: .5rem; margin-top: .5rem; flex-wrap: wrap; }

/* Reply and Resolve belong on one row. Stacked, they were two full-width-looking
   controls of equal weight in a column, and the reader had to work out that the
   second one closes the thread rather than continuing it. */
.thread .threadactions {
  display: flex; gap: .5rem; align-items: flex-start; flex-wrap: wrap;
  margin-top: .5rem;
}
/* A class setting display beats the browser's own [hidden] rule, so hiding it
   from markup needs saying here as well. Found with Reply and Resolve still
   drawn under an open editor that had just told them to stand down. */
.threadactions[hidden] { display: none; }

/* Open, the reply takes the row to itself so the textarea gets the full width
   rather than sharing it with a button. */
.thread .threadactions > details.reply[open] { flex: 1 1 100%; }

/* The reply box starts closed. A thread is usually read, not answered, and an
   open textarea under every one of them reads as work outstanding. */
.thread details.reply > summary {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: .88rem; font-weight: 500; min-height: 2.5rem;
  padding: .45rem .85rem; border-radius: 8px;
  border: 1px solid var(--rule-strong); background: var(--surface);
  color: var(--ink); cursor: pointer; list-style: none;
}
.thread details.reply > summary:hover { border-color: var(--accent); }
.thread details.reply > summary::-webkit-details-marker { display: none; }
.thread details.reply[open] > summary { margin-bottom: .5rem; }

/* Edit and delete, on a comment nobody has read yet.
 *
 * Quiet next to Reply on purpose. Reply is what a thread is usually for, and
 * fixing your own typo is not the reason anyone opened this page. It sits on
 * the header line beside the "not sent" badge, so the control and the state it
 * depends on are read together. */
/* The menu in the comment's own corner.
 *
 * Both actions belong to this one message, while Reply and Resolve below
 * belong to the conversation, so they sit apart. Pushed to the right edge of
 * the metadata line and given the tap target an icon on its own needs. */
.thread .msg { position: relative; }
/* The byline, with the menu at the far end of it. */
.thread .msgmeta { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.thread details.msgmenu { margin-left: auto; }
/* Square and 44px, the size the rail's icon-only control already uses, because
   an icon with no word beside it still has to be hittable with a thumb. */
.thread details.msgmenu > summary {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--tap); height: var(--tap); border-radius: 7px;
  color: var(--muted); cursor: pointer; list-style: none;
  border: 1px solid transparent; font-size: 1rem; line-height: 1;
}
.thread details.msgmenu > summary::-webkit-details-marker { display: none; }
.thread details.msgmenu > summary:hover {
  color: var(--accent); border-color: var(--rule-strong); background: var(--surface-2);
}
.thread details.msgmenu[open] > summary {
  color: var(--accent); border-color: var(--rule-strong); background: var(--surface-2);
}

/* Anchored to the comment rather than the line, so it opens over what follows
   instead of pushing the conversation down as it appears. */
.thread details.msgmenu .popover {
  position: absolute; right: 0; top: 2.1rem; z-index: 5;
  display: grid; min-width: 8rem; gap: .1rem;
  background: var(--surface); border: 1px solid var(--rule-strong);
  border-radius: 9px; padding: .25rem;
  box-shadow: 0 8px 22px rgb(0 0 0 / .18);
}
.thread details.msgmenu .popover form { margin: 0; }
.thread details.msgmenu .item {
  /* justify-content, not text-align: a button carries the browser's own
     centring, and turning it into a flex container moves its text out of
     text-align's reach. Delete sat 27 pixels right of Edit until this said so. */
  display: flex; align-items: center; justify-content: flex-start; width: 100%;
  font: inherit; font-size: .85rem; text-align: left; text-decoration: none;
  padding: .35rem .5rem; min-height: 2.25rem;
  border: 0; border-radius: 6px; background: none; color: var(--ink);
}
.thread details.msgmenu .item:hover { background: var(--accent-soft); color: var(--accent); }
.thread details.msgmenu .item.del { color: var(--del-ink); }
.thread details.msgmenu .item.del:hover { background: var(--del-bg); color: var(--del-ink); }

/* The editor stands where the comment stood. Both at once puts the same
   sentence on screen twice, once editable and once not. */
.thread .editing { margin-top: .4rem; }
/* Save and Cancel where a reader looks first, Delete at the far end. Sharing a
   row with the two controls this state exists for would put the destructive
   one under the same thumb. */
.thread .editactions { display: flex; align-items: center; gap: .4rem; margin-top: .5rem; }
.thread .editactions .deleteform { margin: 0 0 0 auto; }

/* Destructive, and not the reason the menu was opened. Bordered rather than
   filled, so it never competes with Save for the first glance. */
button.danger {
  border-color: var(--del-ink); color: var(--del-ink); background: var(--surface);
}
button.danger:hover { background: var(--del-bg); }

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

/* An action written into the sentence rather than standing in the button row.
   Sending comments as notes decides nothing about the code, so it is the one
   of the three that is not a verdict, and the row has no width for a third
   button once a label carries its scope: measured at 375px the bar holds
   319px, and three scoped buttons want 371px.

   A button and not a link, because it submits the same form the buttons do and
   works with the script unloaded. Underlined, so it does not rely on colour. */
.bar .state .linkbtn {
  /* Every property the button rule sets has to come back off, or a control
     meant to read as a word in a sentence keeps a 2.5rem tap height and sits
     in the line like a block. */
  font: inherit; display: inline; vertical-align: baseline;
  min-height: 0; padding: 0; border: 0; border-radius: 0;
  background: none; color: var(--accent);
  text-decoration: underline; cursor: pointer;
}
.bar .state .linkbtn:hover { text-decoration-thickness: 2px; border-color: transparent; }
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

  /* Four things want this strip on a phone and three of them fit: the title,
     the way back to the files, and the size of what is being read. Measured at
     375px with the drawer closed, keeping the revision as well left the title
     showing four characters.

     The revision is the one to drop because it is reference rather than
     something a reader acts on mid-scroll, and because the page announces the
     part that matters: a new revision arrives as the banner above, which is
     what a stale number would have been warning about. */
  header.top .rev { display: none; }
}

/* ---------- desktop ---------- */

@media (min-width: 1024px) {
  main { padding: 1.25rem 1.5rem; }

  header.top .barcontrols .viewmode { display: inline-flex; }

  /* Room for the ratio as well as the numbers. */
  header.top .wholechange .propbar { display: inline-flex; }

  /* Split needs a diff column wide enough to carry two readable halves, and
     what decides that is the diff column, not the window. Measured at 1024px
     with the rail open: 52 characters a half, 14 of 27 lines wrapping, the
     worst to 11 rows. Honouring the preference there is honouring it into
     uselessness, which is the thing the old breakpoint was trying to avoid and
     landed one notch too low. Closing the rail hands its 19rem to the diff, so
     the same window can carry split once it does. */
  main.view-split.rail-closed .row { grid-template-columns: 1fr 1fr; }
  main.view-split.rail-closed .row[data-unified='right'] > .side.left,
  main.view-split.rail-closed .row[data-unified='left'] > .side.right,
  main.view-split.rail-closed .row > .side { display: grid; }
  main.view-split.rail-closed .row > .side.left { border-right: 1px solid var(--rule); }
  main.view-split.rail-closed .side {
    grid-template-columns: 2.6rem 1.5rem .9rem minmax(0, 1fr);
  }

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

/* Wide enough that split carries two readable halves with the rail still open,
   which is the layout most reviews are actually read in. */
@media (min-width: 1280px) {
  main.view-split .row { grid-template-columns: 1fr 1fr; }
  main.view-split .row[data-unified='right'] > .side.left,
  main.view-split .row[data-unified='left'] > .side.right,
  main.view-split .row > .side { display: grid; }
  main.view-split .row > .side.left { border-right: 1px solid var(--rule); }
  main.view-split .side { grid-template-columns: 2.6rem 1.5rem .9rem minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`

/**
 * How large a page draws, from the daemon's config.
 *
 * A percentage on the root rather than a rewrite of the stylesheet, so one
 * declaration moves every size on the page and nothing else has to know a
 * scale exists. Left out entirely at 1, which keeps the default page byte for
 * byte what it was.
 *
 * The value is clamped here as well as in the schema. The schema is what a
 * config file passes through, and this is what any other caller passes
 * through; a page whose text is a tenth of a millimetre tall is not worth
 * trusting two layers to prevent.
 */
function scaleRule(fontScale: number): SafeHtml {
  const scale = Math.min(1.5, Math.max(0.75, fontScale))
  if (scale === 1) return raw('')

  return html`<style>
    html {
      font-size: ${raw(String(Math.round(scale * 100 * 100) / 100))}%;
    }
  </style>`
}

export function page(
  title: string,
  body: SafeHtml,
  extra: SafeHtml = raw(''),
  fontScale = 1,
): SafeHtml {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title}</title>
        <style>
          ${raw(STYLE)}
        </style>
        ${scaleRule(fontScale)}
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
