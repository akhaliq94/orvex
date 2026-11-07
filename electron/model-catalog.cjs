/**
 * /models endpoints list every asset a provider serves, not only chat models.
 * Groq, for example, returns whisper (speech-to-text), prompt-guard
 * (classification) and orpheus (text-to-speech) beside its chat models. Picking
 * one of those as the chat model fails on the first completion with a 400, so
 * the model dropdown only offers ids that can actually answer a chat request.
 *
 * The match is deliberately narrow: a false positive would hide a working chat
 * model, which is worse than showing one extra row.
 */
const NON_CHAT = [
  /(^|[-_/])whisper([-_/]|$)/i,
  /prompt-guard/i,
  /orpheus/i,
  /(^|[-_/])tts([-_/]|$)/i,
  /(^|[-_/])embed(dings?)?([-_/]|$)/i,
  /(^|[-_/])rerank([-_/]|$)/i,
  /moderation/i,
  /dall-e|stable-diffusion|sdxl|midjourney/i,
];

/** True when the id names a speech, embedding, classifier or image model. */
function nonChatModel(id) {
  const name = String(id || '').trim();
  if (!name) return false;
  return NON_CHAT.some((re) => re.test(name));
}

module.exports = { nonChatModel, NON_CHAT };
