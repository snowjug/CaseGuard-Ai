import { clipText } from './text';
import { codecs, type UrlCodec } from './url-state';

/** Bounded free text: the API refuses longer search and filter values, so the URL never carries them. */
export function boundedString(max: number): UrlCodec<string> {
  const base = codecs.string();
  return {
    parse: (raw) => clipText(base.parse(raw), max),
    serialize: (value) => base.serialize(clipText(value, max)),
  };
}
