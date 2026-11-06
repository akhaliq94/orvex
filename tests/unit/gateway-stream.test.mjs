import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const gateway = require('../../electron/model-gateway.cjs')

const openai = {
  id: 'p1',
  name: 'Test Provider',
  baseUrl: 'https://api.test.example/v1',
  apiKey: 'k',
  model: 'gpt-test',
}
const claude = { ...openai, id: 'p2', name: 'Anthropic Test', baseUrl: 'https://api.test.example', api: 'anthropic' }

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const bodyOf = (frames) =>
  new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })

function serve(...frames) {
  const fetches = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      fetches.push({ url: String(url), init })
      return bodyOf(frames)
    }),
  )
  return fetches
}

afterEach(() => vi.unstubAllGlobals())

describe('streamed chat with tools', () => {
  it('reassembles split tool-call arguments and streams the text as it arrives', async () => {
    const fetches = serve(
      chunk({ choices: [{ delta: { content: 'Let me ' } }] }),
      chunk({ choices: [{ delta: { content: 'check.' } }] }),
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell_run', arguments: '{"comm' } }],
            },
          },
        ],
      }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ipconfig"}' } }] } }] }),
      chunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'files_read', arguments: '{"path":"a.txt"}' } }] },
          },
        ],
      }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      'data: [DONE]\n\n',
    )

    const seen = []
    const out = await gateway.chat({
      candidates: [openai],
      task: 'agent',
      system: 'be brief',
      history: [{ role: 'user', text: 'run ipconfig and read a.txt' }],
      tools: [
        { name: 'shell_run', description: 'run a command', parameters: { type: 'object' } },
        { name: 'files_read', description: 'read a file', parameters: { type: 'object' } },
      ],
      stream: true,
      onDelta: (delta, full) => seen.push([delta, full]),
    })

    expect(fetches[0].url).toBe('https://api.test.example/v1/chat/completions')
    expect(JSON.parse(fetches[0].init.body).stream).toBe(true)
    // The renderer speaks each sentence while it is still being written, so the
    // hook must see the growing text, not just the fragment.
    expect(seen).toEqual([
      ['Let me ', 'Let me '],
      ['check.', 'Let me check.'],
    ])
    expect(out.text).toBe('Let me check.')
    expect(out.calls).toEqual([
      { id: 'call_1', name: 'shell_run', args: { command: 'ipconfig' } },
      { id: 'call_2', name: 'files_read', args: { path: 'a.txt' } },
    ])
    expect(out.usage.promptTokens).toBe(11)
    expect(out.streamed).toBe(true)
  })

  it('keeps unparseable tool arguments instead of dropping the call', async () => {
    serve(
      chunk({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"q":' } }] } }],
      }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    )
    const out = await gateway.chat({
      candidates: [openai],
      history: [{ role: 'user', text: 'search' }],
      tools: [{ name: 'web_search', description: 'search', parameters: { type: 'object' } }],
      stream: true,
    })
    expect(out.calls).toEqual([{ id: 'c', name: 'web_search', args: { _raw: '{"q":' } }])
  })

  it('streams Anthropic text deltas and tool blocks', async () => {
    serve(
      chunk({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working' } }),
      chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' on it' } }),
      chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'files_list' } }),
      chunk({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"dir' } }),
      chunk({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '":"C:/x"}' } }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      chunk({ type: 'message_stop' }),
    )
    const seen = []
    const out = await gateway.chat({
      candidates: [claude],
      history: [{ role: 'user', text: 'list' }],
      tools: [{ name: 'files_list', description: 'list', parameters: { type: 'object' } }],
      stream: true,
      onDelta: (delta, full) => seen.push(full),
    })
    expect(seen).toEqual(['Working', 'Working on it'])
    expect(out.text).toBe('Working on it')
    expect(out.calls).toEqual([{ id: 't1', name: 'files_list', args: { dir: 'C:/x' } }])
    expect(out.usage).toMatchObject({ promptTokens: 5, completionTokens: 9 })
  })

  it('fails loudly when the stream never reaches a terminal event', async () => {
    serve(chunk({ choices: [{ delta: { content: 'half' } }] }))
    await expect(
      gateway.chat({
        candidates: [openai],
        history: [{ role: 'user', text: 'hi' }],
        stream: true,
        onDelta: () => {},
      }),
    ).rejects.toThrow(/stream ended before the response was complete/)
  })

  it('retries a provider that rejects stream_options with a plain stream', async () => {
    const sent = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body)
        sent.push({ stream: body.stream, streamOptions: body.stream_options })
        if (sent.length === 1) {
          return new Response('{"error":{"message":"stream_options is not supported"}}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return bodyOf([
          chunk({ choices: [{ delta: { content: 'answered after retry' } }] }),
          chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ])
      }),
    )
    const events = []
    const out = await gateway.chat({
      candidates: [openai],
      history: [{ role: 'user', text: 'hi' }],
      stream: true,
      onDelta: () => {},
      onEvent: (e) => events.push(e),
    })
    expect(sent).toEqual([
      { stream: true, streamOptions: { include_usage: true } },
      { stream: true, streamOptions: undefined },
    ])
    expect(out.text).toBe('answered after retry')
    expect(events.some((e) => e.type === 'model_retry' && /stream_options/.test(e.reason))).toBe(true)
  })

  it('retries a provider that rejects max_completion_tokens with the legacy field', async () => {
    const sent = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body)
        sent.push(body)
        if (sent.length === 1) {
          return new Response('{"error":{"message":"max_completion_tokens is unsupported"}}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const out = await gateway.chat({
      candidates: [{ ...openai, id: 'p3', model: 'o3-mini' }],
      history: [{ role: 'user', text: 'hi' }],
    })
    expect(sent[0].max_completion_tokens).toBeDefined()
    expect(sent[1].max_completion_tokens).toBeUndefined()
    expect(sent[1].max_tokens).toBeDefined()
    expect(out.text).toBe('ok')
  })
})
