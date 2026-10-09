/**
 * Keep service diagnostics out of customer-facing language.
 *
 * Languages, voice, account status, and generation routing can all receive
 * provider-specific failure messages. Those surfaces need the useful part of
 * a sentence, never model names, qualification gates, or environment keys.
 */
const ENGINEERING = /(model|qualif|provider|token|reservation|local-only|gemma|anthropic|vertex|gguf|llama|credential|determinis)/i;
const SETTING = /[A-Z]{3,}_[A-Z0-9_]{3,}/;

export function plain(sentence: string | null | undefined): string | null {
  if (!sentence) return null;
  return ENGINEERING.test(sentence) || SETTING.test(sentence) ? "Not set up yet." : sentence;
}

/** Use a surface-specific fallback when the service reports engineering text. */
export function serviceWords(sentence: string | null | undefined, fallback: string): string {
  return sentence && plain(sentence) === sentence ? sentence : fallback;
}
