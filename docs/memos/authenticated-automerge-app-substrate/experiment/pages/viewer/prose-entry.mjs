// Content attributes for the Wordgard roots people write prose in: the Page
// body and every comment composer. They mark the field as free text, not a
// form field Safari should offer AutoFill for, and keep the keyboard's
// correction and capitalization on so QuickType suggestions stay.
//
// WebKit reads autocorrect, autocapitalize and spellcheck on a contenteditable
// and forwards them to the iOS keyboard. It doesn't read autocomplete there;
// that one is a hint for Safari and password managers. The Page title input
// in main.jsx sets the same autocomplete, autocorrect and autocapitalize
// values as JSX props and leaves spellcheck at the input default.
export const PROSE_ENTRY_ATTRIBUTES = Object.freeze({
  autocomplete: "off",
  autocorrect: "on",
  autocapitalize: "sentences",
  spellcheck: "true",
});
