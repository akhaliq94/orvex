import { describe, expect, it } from 'vitest'
import { nonChatModel } from '../../electron/model-catalog.cjs'

describe('non-chat model filter', () => {
  it('keeps the Groq chat models', () => {
    for (const id of [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-safeguard-20b',
      'qwen/qwen3.8-27b',
      'allam-2-7b',
      'llama-3.3-70b-versatile',
      'gemini-2.5-flash',
      'anthropic/claude-sonnet-4',
    ]) {
      expect(nonChatModel(id), id).toBe(false)
    }
  })

  it('drops the speech, classifier and image families Groq lists beside chat', () => {
    for (const id of [
      'whisper-large-v3',
      'whisper-large-v3-turbo',
      'distil-whisper-large-v3-en',
      'meta-llama/llama-prompt-guard-2-22m',
      'canopylabs/orpheus-v1-english',
      'canopylabs/orpheus-arabic-saudi',
      'tts-1',
      'gpt-4o-mini-tts',
      'text-embedding-3-small',
      'nomic-embed-text',
      'dall-e-3',
      'omni-moderation-latest',
    ]) {
      expect(nonChatModel(id), id).toBe(true)
    }
  })

  it('does not treat unrelated words as non-chat', () => {
    expect(nonChatModel('')).toBe(false)
    expect(nonChatModel('my-embeddingless-chat')).toBe(false)
    expect(nonChatModel('whisperer-chat-7b')).toBe(false)
  })
})
