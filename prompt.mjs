// Flattens OpenAI chat completion payloads (system/developer instructions,
// multi-turn history, tool definitions, tool results, and JSON response format)
// into a single HiAgent text turn, and parses <tool_call> or {"tool_calls":...}
// blocks back into OpenAI tool_calls.

const OPEN = "<tool_call>"
const CLOSE = "</tool_call>"
const JSON_KEY = '{"tool_calls"'
const JSON_AT = /(^|\n)[ \t]*\{\s*"tool_calls"\s*:/g

function partText(content) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return typeof content === "object" ? JSON.stringify(content) : String(content)
  return content
    .map((p) => {
      if (typeof p === "string") return p
      if (p?.type === "text" || p?.type === "input_text") return p.text ?? ""
      if (p?.type === "image_url" || p?.type === "input_image" || p?.type === "image") return "[image omitted: text-only proxy mode]"
      if (p?.type === "file" || p?.type === "input_file") return "[file omitted: text-only proxy mode]"
      return p?.text ?? ""
    })
    .join("")
}

function toolLine(t) {
  const f = t?.function ?? t
  if (!f?.name) return null
  const desc = String(f.description ?? "").trim()
  const params = f.parameters ? JSON.stringify(f.parameters) : "{}"
  return `## ${f.name}\n${desc ? desc + "\n" : ""}Arguments (JSON Schema): ${params}`
}

function callText(c) {
  const f = c?.function ?? c
  let args = f?.arguments ?? {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args || "{}")
    } catch {}
  }
  return OPEN + JSON.stringify({ name: f?.name, arguments: args }) + CLOSE
}

function choice(body, names) {
  const c = body?.tool_choice
  if (c === "none") return { off: true }
  if (c === "required") return { must: true }
  const name = c?.function?.name ?? c?.name
  if (name && names.includes(name)) return { must: true, only: name }
  return {}
}

/**
 * Flatten an OpenAI Chat Completions request body into a single prompt string.
 */
export function flatten(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map((t) => ({ line: toolLine(t), name: (t?.function ?? t)?.name }))
    .filter((t) => t.line)
  const ch = choice(body, tools.map((t) => t.name))
  const useTools = tools.length > 0 && !ch.off

  const out = []
  out.push(
    "You are the language model behind a client application. You cannot execute actions yourself and must not claim to run tools directly: you only write text.",
  )
  if (useTools) {
    out.push(
      `When a tool action is needed, reply with one or more blocks of exactly\n${OPEN}{"name": "<tool>", "arguments": {...}}${CLOSE}\nand nothing after them. The client runs them and sends the results in the next turn. When no tool action is needed, answer in plain text without ${OPEN} blocks.`,
    )
    if (ch.only) out.push(`You must call the tool ${ch.only} now.`)
    else if (ch.must) out.push("You must call at least one tool now.")
  }

  const system = messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => partText(m.content).trim())
    .filter(Boolean)
  if (system.length) out.push("# Instructions from the client\n\n" + system.join("\n\n"))
  if (useTools) out.push("# Tools\n\n" + tools.map((t) => t.line).join("\n\n"))

  if (body?.response_format?.type === "json_object" || body?.response_format?.type === "json_schema") {
    const schema = body.response_format.json_schema?.schema
    out.push(
      "Answer with one valid JSON value and nothing else." +
        (schema ? " It must match this JSON Schema: " + JSON.stringify(schema) : ""),
    )
  }

  const names = new Map()
  const turns = []
  for (const m of messages) {
    if (!m || m.role === "system" || m.role === "developer") continue
    if (m.role === "user") {
      turns.push("[user]\n" + partText(m.content))
    } else if (m.role === "assistant") {
      const parts = []
      const text = partText(m.content)
      if (text.trim()) parts.push(text)
      for (const c of m.tool_calls ?? []) {
        if (c?.id) names.set(c.id, c.function?.name)
        parts.push(callText(c))
      }
      if (parts.length) turns.push("[assistant]\n" + parts.join("\n"))
    } else if (m.role === "tool" || m.role === "function") {
      const n = m.name ?? names.get(m.tool_call_id)
      turns.push(`[tool result${n ? " of " + n : ""}]\n` + partText(m.content))
    }
  }
  if (turns.length) out.push("# Conversation so far\n\n" + turns.join("\n\n"))
  out.push("Write the next [assistant] turn now, without the [assistant] label.")
  return out.join("\n\n")
}

const inCode = (text, at) => (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1

function jsonStarts(text) {
  const out = []
  for (const m of text.matchAll(JSON_AT)) {
    const at = text.indexOf("{", m.index)
    if (!inCode(text, at)) out.push(at)
  }
  return out
}

function jsonEnd(v) {
  let depth = 0
  let str = false
  for (let k = 0; k < v.length; k++) {
    const c = v[k]
    if (str) {
      if (c === "\\") k++
      else if (c === '"') str = false
    } else if (c === '"') {
      str = true
    } else if (c === "{" || c === "[") {
      depth++
    } else if (c === "}" || c === "]") {
      if (--depth === 0) return k + 1
    }
  }
  return -1
}

function jsonCalls(v) {
  let f
  try {
    f = JSON.parse(v)
  } catch {
    return null
  }
  const list = f?.tool_calls
  if (!Array.isArray(list) || !list.length) return null
  const calls = []
  for (const e of list) {
    const fn = e?.function ?? e
    let args = fn?.arguments ?? {}
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        return null
      }
    }
    const name = String(fn?.name ?? "").trim()
    if (!name || !args || typeof args !== "object" || Array.isArray(args)) return null
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls
}

/**
 * Return the safe prefix length of `text` to stream before any potential tool call block.
 */
export function heldFrom(text) {
  let at = -1
  let pos = 0
  while ((pos = text.indexOf(OPEN, pos)) >= 0) {
    if (!inCode(text, pos)) {
      at = pos
      break
    }
    pos += OPEN.length
  }
  const j = jsonStarts(text)[0]
  if (j !== undefined && (at < 0 || j < at)) at = text.lastIndexOf("\n", j) + 1
  if (at >= 0) return at

  const nl = text.lastIndexOf("\n")
  const line = text.slice(nl + 1)
  const bare = line.replace(/\s+/g, "")
  if (bare && JSON_KEY.startsWith(bare) && !inCode(text, nl + 1)) return nl + 1

  for (let n = Math.min(OPEN.length - 1, text.length); n > 0; n--) {
    if (OPEN.startsWith(text.slice(-n)) && !inCode(text, text.length - n)) return text.length - n
  }
  return text.length
}

function parseCall(raw) {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  let v
  try {
    v = JSON.parse(s)
  } catch {
    return null
  }
  if (Array.isArray(v)) v = v[0]
  const name = v?.name ?? v?.function?.name ?? v?.tool
  if (typeof name !== "string" || !name) return null
  let args = v.arguments ?? v.parameters ?? v.input ?? v.args ?? v.function?.arguments ?? {}
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {}
  }
  return { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) }
}

/**
 * Parse <tool_call> blocks and standalone {"tool_calls": [...]} objects out of a completed reply.
 */
export function parse(text, newId = () => "call_" + Math.random().toString(36).slice(2, 14)) {
  const calls = []
  const lifted = []
  let rest = ""
  let i = 0
  while (i < text.length) {
    const at = text.indexOf(OPEN, i)
    if (at < 0) {
      rest += text.slice(i)
      break
    }
    if (inCode(text, at)) {
      rest += text.slice(i, at + OPEN.length)
      i = at + OPEN.length
      continue
    }
    rest += text.slice(i, at)
    const end = text.indexOf(CLOSE, at + OPEN.length)
    const raw = text.slice(at + OPEN.length, end < 0 ? text.length : end)
    const call = parseCall(raw)
    if (call) calls.push({ id: newId(), type: "function", function: call })
    else rest += text.slice(at, end < 0 ? text.length : end + CLOSE.length)
    i = end < 0 ? text.length : end + CLOSE.length
  }

  for (const at of jsonStarts(rest).reverse()) {
    const end = jsonEnd(rest.slice(at))
    const got = end < 0 ? null : jsonCalls(rest.slice(at, at + end))
    if (!got) continue
    lifted.unshift(...got)
    rest = rest.slice(0, at) + rest.slice(at + end)
  }
  for (const c of lifted) calls.push({ id: newId(), type: "function", function: c })

  const cleaned = calls.length ? rest.replace(/```[a-z]*\s*```/gi, "") : rest
  return { text: calls.length ? cleaned.trim() : rest, calls, raw: rest }
}
