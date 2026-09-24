/**
 * Cuts streamed text into sentences as soon as each one is complete, so a
 * sentence can be acted on while the next is still arriving.
 *
 * A sentence ends at `.`, `!`, `?` or `…` — plus any closing quotes or
 * brackets after it — once whitespace follows. Waiting for the whitespace is
 * what keeps "3.5" whole, and is why the last sentence only comes out of
 * `end()`: nothing follows it. Spanish's opening `¿` and `¡` need nothing
 * special, since each pair still closes on an ordinary `?` or `!`.
 *
 * An abbreviation like "Sr. García" is split after "Sr.". Rare at the level
 * this app speaks at, and harmless: it's still spoken in order, just as one
 * more piece.
 */
export interface SentenceSplitter {
  /** Adds the next piece of text. */
  push(text: string): void;
  /** Flushes whatever is left as the final sentence. */
  end(): void;
}

const SENTENCE_END = /[.!?…]+["'”’»)\]]*\s+/g;

export function createSentenceSplitter(
  onSentence: (sentence: string) => void,
): SentenceSplitter {
  let buffer = '';

  function emit(text: string) {
    const sentence = text.trim();
    if (sentence) onSentence(sentence);
  }

  return {
    push(text) {
      buffer += text;

      let cut = 0;
      for (const match of buffer.matchAll(SENTENCE_END)) {
        const end = match.index + match[0].length;
        emit(buffer.slice(cut, end));
        cut = end;
      }
      buffer = buffer.slice(cut);
    },

    end() {
      emit(buffer);
      buffer = '';
    },
  };
}
