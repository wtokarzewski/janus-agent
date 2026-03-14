/**
 * Strip leaked LLM control tokens from user-facing text.
 *
 * Models sometimes leak training artifacts such as <|endoftext|>,
 * <|im_start|>, [INST], <s>, </s> etc. into their output.
 * This function removes them before the text reaches the user.
 */

const CONTROL_TOKEN_RE =
  // <|...|> family (GPT, Qwen, DeepSeek, Mistral, etc.)
  /<\|[a-z_/]+\|>/gi;

const BRACKET_TAG_RE =
  // [INST], [/INST], [SYS], [/SYS], <<SYS>>, <</SYS>>
  /\[\/?(INST|SYS)\]|<<\/?(SYS)>>/gi;

const SENTENCE_TAG_RE =
  // <s>, </s> (sentence boundary markers)
  /<\/?s>/gi;

/**
 * Strip invisible Unicode characters that can bypass security regex patterns.
 * Removes zero-width spaces, joiners, Mongolian vowel separator, etc.
 */
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u2028-\u202F\u2060-\u2069\u180E\uFEFF\u00AD]/g;

export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, '');
}

export function stripControlTokens(text: string): string {
  return text
    .replace(CONTROL_TOKEN_RE, '')
    .replace(BRACKET_TAG_RE, '')
    .replace(SENTENCE_TAG_RE, '')
    .trim();
}
