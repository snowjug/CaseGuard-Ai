/**
 * The first `max` UTF-16 units of `text`, without ever leaving half of a surrogate pair at the cut: an emoji or another
 * character outside the Basic Multilingual Plane would otherwise end in a replacement character (in a label, in the
 * accessible name of a control, or in a search term sent to the API). The result is never longer than `max`, which is
 * how the API counts its limits.
 */
export function clipText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}
