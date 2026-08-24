/**
 * Was `.prettierrc.json`. It is JavaScript now because the setting below needs
 * a reason attached and JSON has nowhere to put one.
 */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',

  /**
   * Leave the insides of tagged templates alone.
   *
   * `html` templates in src/daemon/web are not source that happens to look like
   * markup; the whitespace in them is the page the reviewer reads. Prettier's
   * embedded-HTML pass reflows it, and did: it broke `<details>` across five
   * lines, turned a leading newline into a space, and rewrote the indentation
   * inside every template on the page. None of that was caught by a test that
   * meant to catch it. Three tests failed by accident, on a regex matching an
   * unrelated tag, while the whitespace that actually matters went unchecked.
   *
   * It also could not settle. From a hand-formatted file the pass needed two
   * runs to reach a fixed point, so `npm run format` once left the tree in a
   * state `prettier --check` rejected — a contributor's first pull request
   * would have arrived with a red CI and nothing to show for it. Reproduced on
   * prettier 3.9.6 against review-page.ts, pages.ts, and layout.ts.
   *
   * Off, both problems go away, and the one file that renders the diff keeps
   * the shape its author gave it. The rest of the tree is formatted as before.
   */
  embeddedLanguageFormatting: 'off',
}
