// Formats HiAgent streaming and completed replies into standard OpenAI
// Chat Completions SSE chunks and JSON payloads.
import { heldFrom, parse } from "./prompt.mjs"

const enc = new TextEncoder()

/**
 * Incremental delta tracker that holds back potential <tool_call> prefixes
 * while streaming reasoning and content tokens.
 */
export class Streamer {
  constructor() {
    this.text = ""
    this.shown = 0
    this.reasoning = ""
  }

  update({ text = "", reasoning = "" } = {}) {
    const out = {}
    if (reasoning.startsWith(this.reasoning) && reasoning.length > this.reasoning.length) {
      out.reasoning = reasoning.slice(this.reasoning.length)
      this.reasoning = reasoning
    }
    if (text.startsWith(this.text.slice(0, this.shown))) {
      this.text = text
      const upto = heldFrom(text)
      if (upto > this.shown) {
        out.content = text.slice(this.shown, upto)
        this.shown = upto
      }
    }
    return out
  }

  finish(final, newId) {
    const p = parse(final?.text ?? this.text, newId)
    const shown = this.text.slice(0, this.shown)
    let content = p.raw.startsWith(shown) ? p.raw.slice(shown.length) : ""
    if (p.calls.length) {
      content = content.replace(/```[a-z]*\s*```/gi, "").trim()
        ? content.replace(/```[a-z]*\s*```/gi, "").trimEnd()
        : ""
    }
    return { content, calls: p.calls }
  }
}

/**
 * Resolve OpenAI-style token usage, falling back to character estimates when
 * the upstream HiAgent SSE usage frame omits or zeroes token counts.
 */
export function usage(promptTokens, text = "", reasoning = "", serverUsage = null) {
  const pt = Number(serverUsage?.prompt_tokens)
  const ct = Number(serverUsage?.completion_tokens)
  const tt = Number(serverUsage?.total_tokens)
  if ((Number.isFinite(pt) && pt > 0) || (Number.isFinite(ct) && ct > 0)) {
    const prompt_tokens = Number.isFinite(pt) && pt > 0 ? pt : promptTokens
    const completion_tokens =
      Number.isFinite(ct) && ct > 0
        ? ct
        : Math.ceil(((text ?? "").length + (reasoning ?? "").length) / 3)
    const total_tokens = Number.isFinite(tt) && tt > 0 ? tt : prompt_tokens + completion_tokens
    return { prompt_tokens, completion_tokens, total_tokens }
  }
  const completion = Math.ceil(((text ?? "").length + (reasoning ?? "").length) / 3)
  return { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion }
}

const chunk = (id, model, delta, finish = null, extra = {}) =>
  enc.encode(
    "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      }) +
      "\n\n",
  )

/**
 * Execute `ask(onUpdate, signal)` and stream OpenAI SSE chunks.
 * Pre-stream errors reject before returning the HTTP 200 Response so the caller
 * can emit a proper HTTP error status or trigger re-authentication.
 */
export async function sse({ id, model, ask, signal, promptTokens = () => 0, newId }) {
  const st = new Streamer()
  const abort = new AbortController()
  const both = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const buf = []
  let ctl = null
  let ended = false
  let failure = null
  let begun = false
  let onFirst
  const first = new Promise((r) => (onFirst = r))
  const push = (b) => (ctl ? ctl.enqueue(b) : buf.push(b))
  const deltas = (d) => {
    if (d.reasoning) push(chunk(id, model, { reasoning_content: d.reasoning }))
    if (d.content) push(chunk(id, model, { content: d.content }))
  }

  push(chunk(id, model, { role: "assistant", content: "" }))
  ;(async () => {
    try {
      const final = await ask((r) => {
        begun = true
        onFirst()
        deltas(st.update(r))
      }, both)
      begun = true
      deltas(st.update(final))
      const { content, calls } = st.finish(final, newId)
      if (content) push(chunk(id, model, { content }))
      if (calls.length) {
        push(
          chunk(id, model, {
            tool_calls: calls.map((x, index) => ({
              index,
              id: x.id,
              type: "function",
              function: x.function,
            })),
          }),
        )
      }
      push(chunk(id, model, {}, calls.length ? "tool_calls" : "stop"))
      push(
        chunk(id, model, {}, null, {
          choices: [],
          usage: usage(promptTokens(final), final?.text, final?.reasoning, final?.usage),
        }),
      )
      push(enc.encode("data: [DONE]\n\n"))
    } catch (e) {
      failure = e
      if (begun && !both.aborted) {
        push(
          enc.encode(
            "data: " +
              JSON.stringify({
                error: { message: String(e?.message ?? e), type: e?.code ?? "hiagent_error" },
              }) +
              "\n\n",
          ),
        )
      }
    } finally {
      ended = true
      onFirst()
      if (ctl) {
        try {
          ctl.close()
        } catch {}
      }
    }
  })()

  await first
  if (failure && !begun) throw failure

  const stream = new ReadableStream({
    start(c) {
      ctl = c
      for (const b of buf.splice(0)) c.enqueue(b)
      if (ended) c.close()
    },
    cancel() {
      abort.abort()
    },
  })
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  })
}

/**
 * Format a completed HiAgent reply as a non-streaming OpenAI Chat Completion JSON object.
 */
export function completion({ id, model, final, promptTokens, newId }) {
  const { text, calls } = parse(final?.text ?? "", newId)
  const message = { role: "assistant", content: text || (calls.length ? null : "") }
  if (final?.reasoning) message.reasoning_content = final.reasoning
  if (calls.length) message.tool_calls = calls
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usage(promptTokens, final?.text, final?.reasoning, final?.usage),
  }
}
