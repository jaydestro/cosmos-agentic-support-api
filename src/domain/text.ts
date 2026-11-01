/** Cuts `text` to at most `max` UTF-16 units, ending with an ellipsis, without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
