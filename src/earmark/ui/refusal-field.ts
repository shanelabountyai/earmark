// D-81, D-87: which field a refusal names. A refusal that starts with a field's label ("Amount must be …", "Due date
// cannot …") is about that field; the label's words before any "(USD)"-style aside are what it names the field by.
// Pure, so the rule has a unit test (tests/earmark/refusal-field.test.ts); Form applies it to the DOM.

/** The label's words before any "(USD)"-style aside. */
export const labelHead = (labelText: string | null | undefined): string => (labelText ?? '').replace(/\(.*$/, '').trim();

/** Whether `error` names the field whose label text is `labelText`. An empty label names nothing. */
export function refusalNames(error: string, labelText: string | null | undefined): boolean {
  const head = labelHead(labelText);
  return head !== '' && error.startsWith(head);
}
