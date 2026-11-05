const SPEECH_LIMIT = 700

/**
 * Emoji and their invisible joiners/selectors. Spoken text should never include
 * them: engines either name them ("smiling face") or emit noise.
 */
const EMOJI = /[\d#*]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\uFE0E\u200D\u20E3]+/gu

/**
 * Spoken text is not read text: code fences, links, markup and emoji are noise
 * once read aloud. Keeps the first ~700 characters — roughly a minute of speech
 * — and cuts at the last sentence boundary it finds.
 */
export function forSpeech(text: string): string {
  const out = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\s]*[-*•]\s+/gm, ' ')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length <= SPEECH_LIMIT) return out
  const cut = out.slice(0, SPEECH_LIMIT)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return `${stop > 200 ? cut.slice(0, stop + 1) : cut}…`
}
