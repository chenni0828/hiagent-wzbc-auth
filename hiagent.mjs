// HiAgent client supporting both:
// 1) Web Experience reverse-proxy mode via `/api/aigw`, `/api/iam`, and `/api/bypass/aigw?Action=Chat`
//    (authenticated with browser session cookies + `x-csrf-token` header), and
// 2) Direct OpenAI-compatible AI Gateway API Key mode via `/api/aigw/v1/*`.
import { extractWorkspaceFromUrl } from "./browser.mjs"

export const DEFAULT_ORIGIN = "https://agent.wzbc.edu.cn"
export const DEFAULT_REGION = "cn-north-1"
export const AIGW_VERSION = "2023-08-01"
export const IAM_VERSION = "2024-12-25"

export const DEFAULT_MODELS = {
  "Kimi-K3.1-Pro": {
    id: "dbqnudlojh3qs574937g",
    name: "Kimi-K3.1-Pro",
    modelName: "Kimi-K3.1-Pro",
    publishSourceType: "external",
    context: 256000,
    maxOutput: 102400,
    defaultMaxTokens: 32768,
    reasoning: true,
    vision: true,
    toolCall: true,
  },
}

export class HiAgentError extends Error {
  constructor(message, { status = 502, code = "hiagent_error", signIn = false } = {}) {
    super(message)
    this.name = "HiAgentError"
    this.status = status
    this.code = code
    this.signIn = signIn
  }
}

/**
 * Parse a Cookie header string (optionally prefixed with `Cookie:`) into a map.
 */
export function parseCookieHeader(raw) {
  const out = {}
  const s = String(raw ?? "")
    .trim()
    .replace(/^cookie:\s*/i, "")
  if (!s) return out
  for (const part of s.split(";")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export function serializeCookies(cookies) {
  return Object.entries(cookies ?? {})
    .filter(([k, v]) => k && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

/**
 * Apply any `Set-Cookie` headers onto `cookies`. Returns `true` if any cookie changed.
 */
export function mergeSetCookies(cookies, headers) {
  if (!headers) return false
  let list = []
  if (typeof headers.getSetCookie === "function") {
    list = headers.getSetCookie()
  } else if (typeof headers.get === "function") {
    const raw = headers.get("set-cookie")
    if (raw) list = raw.split(/,(?=\s*[^;=,\s]+=[^;]+)/)
  }
  let changed = false
  for (const item of list) {
    const first = String(item).split(";")[0] ?? ""
    const eq = first.indexOf("=")
    if (eq <= 0) continue
    const k = first.slice(0, eq).trim()
    const v = first.slice(eq + 1).trim()
    if (!k) continue
    if (cookies[k] !== v) {
      cookies[k] = v
      changed = true
    }
  }
  return changed
}

/**
 * Stream and parse SSE `data:` frames from a ReadableStream.
 */
export async function parseSseLines(stream, onData, signal) {
  if (!stream) return
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let dataLines = []

  const flushEvent = () => {
    if (!dataLines.length) return false
    const payload = dataLines.join("\n")
    dataLines = []
    if (payload === "[DONE]") return true
    onData(payload)
    return false
  }

  try {
    while (true) {
      if (signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) {
        buf += dec.decode()
        break
      }
      buf += dec.decode(value, { stream: true })
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (line === "") {
          if (flushEvent()) return
          continue
        }
        if (line.startsWith(":")) continue
        if (line.startsWith("data:")) {
          const val = line.slice(5)
          dataLines.push(val.startsWith(" ") ? val.slice(1) : val)
        }
      }
    }
    if (buf.startsWith("data:")) {
      const val = buf.slice(5)
      dataLines.push(val.startsWith(" ") ? val.slice(1) : val)
    }
    flushEvent()
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

function isAuthFailure(status, url, contentType, text) {
  if (status === 401 || status === 403) return true
  if (String(url ?? "").includes("/login")) return true
  if (String(contentType ?? "").includes("text/html")) return true
  try {
    const j = JSON.parse(text)
    const code = String(j?.ResponseMetadata?.Error?.Code ?? j?.code ?? "")
    const msg = String(j?.ResponseMetadata?.Error?.Message ?? j?.message ?? "")
    if (/EBADCSRFTOKEN|unauthorized|unauthenticated|invalid csrf|token.*expired|not login/i.test(`${code} ${msg}`)) {
      return true
    }
  } catch {}
  return false
}

export class Session {
  constructor({
    origin = DEFAULT_ORIGIN,
    workspaceId = "",
    cookies = null,
    apiKey = "",
    region = DEFAULT_REGION,
    fetchImpl = globalThis.fetch,
    renew = null,
    onCookies = null,
    keepHistory = false,
  } = {}) {
    this.origin = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "")
    this.workspaceId = String(workspaceId || "")
    this.cookies = cookies && typeof cookies === "object" ? { ...cookies } : null
    this.apiKey = String(apiKey || "")
    this.region = region || DEFAULT_REGION
    this.fetchImpl = fetchImpl
    this.renew = renew
    this.onCookies = onCookies
    this.keepHistory = !!keepHistory
    this._renewing = null
  }

  get mode() {
    return this.apiKey ? "apikey" : "web"
  }

  get signedIn() {
    if (this.apiKey) return true
    return !!(this.cookies && this.cookies["x-csrf-token"] && Object.keys(this.cookies).length > 0)
  }

  headers(accept = "application/json, text/plain, */*") {
    const h = {
      "Content-Type": "application/json",
      Accept: accept,
      "Accept-Language": "zh",
      "x-top-region": this.region,
      Origin: this.origin,
      Referer: this.workspaceId
        ? `${this.origin}/product/maas/personal/${this.workspaceId}/experience`
        : `${this.origin}/product/maas/`,
    }
    if (this.cookies) {
      const serialized = serializeCookies(this.cookies)
      if (serialized) h.Cookie = serialized
      if (this.cookies["x-csrf-token"]) h["x-csrf-token"] = this.cookies["x-csrf-token"]
    }
    if (this.workspaceId) h.workspaceid = this.workspaceId
    return h
  }

  async _tryRenew() {
    if (!this.renew) return false
    if (!this._renewing) {
      this._renewing = (async () => {
        const res = await this.renew()
        const nextCookies = res?.cookies ?? (res && !res.cookies ? res : null)
        if (!nextCookies || !nextCookies["x-csrf-token"]) return false
        this.cookies = { ...nextCookies }
        if (res?.workspaceId && !this.workspaceId) this.workspaceId = res.workspaceId
        this.onCookies?.(this.cookies, this.workspaceId)
        return true
      })().finally(() => {
        this._renewing = null
      })
    }
    return await this._renewing
  }

  async rpc(servicePath, action, body = {}, { version = AIGW_VERSION, region = this.region, signal, allowRetry = true } = {}) {
    if (!this.signedIn) {
      throw new HiAgentError("尚未登录 HiAgent，请先登录。", { status: 401, code: "not_signed_in", signIn: true })
    }
    const qs = new URLSearchParams({ Action: action, Version: version })
    if (region) qs.set("Region", region)
    const url = `${this.origin}${servicePath}?${qs.toString()}`

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    })

    if (this.cookies && mergeSetCookies(this.cookies, res.headers)) {
      this.onCookies?.(this.cookies, this.workspaceId)
    }

    const text = await res.text()
    const ct = res.headers.get("content-type") || ""
    if (isAuthFailure(res.status, res.url, ct, text)) {
      if (allowRetry && (await this._tryRenew())) {
        return await this.rpc(servicePath, action, body, { version, region, signal, allowRetry: false })
      }
      throw new HiAgentError("HiAgent 登录态已失效或 CSRF 校验失败，请重新登录。", {
        status: 401,
        code: "session_expired",
        signIn: true,
      })
    }

    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new HiAgentError(`HiAgent ${action} 返回了非 JSON 响应 (${res.status})`, {
        status: res.status >= 400 ? res.status : 502,
        code: "invalid_response",
      })
    }

    const err = json?.ResponseMetadata?.Error
    if (!res.ok || err) {
      const msg = err?.Message || json?.message || `HiAgent ${action} 请求失败 (${res.status})`
      const code = err?.Code || json?.code || "hiagent_error"
      throw new HiAgentError(msg, { status: res.status >= 400 ? res.status : 502, code })
    }
    return json?.Result ?? json
  }

  async discoverWorkspace({ signal } = {}) {
    if (this.workspaceId) return this.workspaceId
    const res = await this.rpc("/api/iam", "ListWorkspace", {}, { version: IAM_VERSION, region: "", signal })
    const items = res?.Items
    if (Array.isArray(items) && items.length && items[0]?.ID) {
      this.workspaceId = items[0].ID
      this.onCookies?.(this.cookies, this.workspaceId)
      return this.workspaceId
    }
    const pageRes = await this.fetchImpl(`${this.origin}/product/maas/`, {
      method: "GET",
      headers: {
        Accept: "text/html",
        ...(this.cookies ? { Cookie: serializeCookies(this.cookies) } : {}),
      },
      redirect: "follow",
      signal,
    })
    const fromUrl = extractWorkspaceFromUrl(pageRes.url)
    if (fromUrl) {
      this.workspaceId = fromUrl
      this.onCookies?.(this.cookies, this.workspaceId)
      return this.workspaceId
    }
    throw new HiAgentError(
      "未能自动识别 HiAgent WorkspaceID（个人空间 ID），请在登录配置中填写 WorkspaceID（形如 personal-xxxx）。",
      { status: 400, code: "missing_workspace" },
    )
  }

  async listModels({ signal } = {}) {
    if (this.mode === "apikey") {
      const res = await this.fetchImpl(`${this.origin}/api/aigw/v1/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal,
      })
      if (res.status === 401 || res.status === 403) {
        throw new HiAgentError("HiAgent AI Gateway API Key 无效或已过期。", {
          status: 401,
          code: "invalid_api_key",
          signIn: true,
        })
      }
      if (!res.ok) {
        throw new HiAgentError(`获取模型列表失败 (${res.status})`, { status: res.status })
      }
      const data = await res.json()
      const out = {}
      for (const item of data?.data ?? []) {
        if (!item?.id) continue
        out[item.id] = {
          id: item.id,
          name: item.id,
          modelName: item.id,
          publishSourceType: "gateway",
          context: 128000,
          maxOutput: 32768,
          defaultMaxTokens: 32768,
          reasoning: true,
          vision: false,
          toolCall: true,
        }
      }
      return out
    }

    const workspaceId = await this.discoverWorkspace({ signal })
    let res = await this.rpc(
      "/api/aigw",
      "ListModelByWorkspaceGrant",
      {
        WorkspaceID: workspaceId,
        Filter: { IsPublished: true, IsGranted: true },
        ListOpt: { Sort: [{ SortField: "created_at", SortOrder: "desc" }] },
      },
      { signal },
    )
    let items = res?.Items
    if (!Array.isArray(items) || !items.length) {
      res = await this.rpc(
        "/api/aigw",
        "ListModelByWorkspaceGrant",
        {
          WorkspaceID: workspaceId,
          Filter: { IsGranted: true },
        },
        { signal },
      )
      items = res?.Items
    }

    const out = {}
    for (const m of items ?? []) {
      if (m?.Type && m.Type !== "text-generation") continue
      if (m?.Status && m.Status !== "Running") continue
      const key = m?.ModelName || m?.Name
      if (!key || !m?.ID) continue
      const features = Array.isArray(m.FeaturesConfig) ? m.FeaturesConfig : []
      const tokenCfg = m?.Property?.LLM?.Token ?? {}
      const maxCfg = tokenCfg?.MaxTokens ?? {}
      out[key] = {
        id: m.ID,
        name: m.Name || key,
        modelName: m.ModelName || key,
        publishSourceType: m.PublishSourceType || "external",
        context: Number(tokenCfg.ContextTokens) || 256000,
        maxOutput: Number(maxCfg.Max) || 102400,
        defaultMaxTokens: Number(maxCfg.Default) || 32768,
        reasoning: features.includes("reasoning") || !!m?.Property?.LLM?.API?.Chat?.Features?.includes("reasoning"),
        vision: features.includes("vision"),
        toolCall: true,
      }
    }
    return out
  }

  async _applyMaxTokens({ conversationId, sessionId, modelServiceId, workspaceId, maxTokens, signal }) {
    try {
      const settingsRes = await this.rpc(
        "/api/aigw",
        "GetModelUserSettings",
        {
          ConversationID: conversationId,
          SessionID: sessionId,
          ModelServiceID: modelServiceId,
          WorkspaceID: workspaceId,
        },
        { signal },
      )
      const raw = settingsRes?.ModelVersionConfiguration?.UserSettings
      if (typeof raw !== "string") return
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      const item = arr.find((x) => x?.Name === "max_tokens")
      if (!item) return
      const min = Number(item.Min) || 1
      const max = Number(item.Max) || 102400
      const clamped = Math.max(min, Math.min(max, Math.trunc(maxTokens)))
      if (String(clamped) === String(item.Value ?? item.Default)) return
      item.Value = String(clamped)
      await this.rpc(
        "/api/aigw",
        "UpdateModelUserSettings",
        {
          WorkspaceID: workspaceId,
          SessionID: sessionId,
          ConversationID: conversationId,
          ModelServiceID: modelServiceId,
          UserSettings: JSON.stringify(arr),
        },
        { signal },
      )
    } catch {
      // Best-effort only: never block chat if optional settings update fails
    }
  }

  async _openChatStream({ sessionId, messageId, workspaceId, signal, allowRetry = true }) {
    const qs = new URLSearchParams({
      Action: "Chat",
      Version: AIGW_VERSION,
      Region: this.region,
    })
    const res = await this.fetchImpl(`${this.origin}/api/bypass/aigw?${qs.toString()}`, {
      method: "POST",
      headers: this.headers("text/event-stream"),
      body: JSON.stringify({
        SessionID: sessionId,
        MessageID: messageId,
        WorkspaceID: workspaceId,
      }),
      signal,
    })

    if (this.cookies && mergeSetCookies(this.cookies, res.headers)) {
      this.onCookies?.(this.cookies, this.workspaceId)
    }

    const ct = res.headers.get("content-type") || ""
    if (!res.ok || !ct.includes("text/event-stream")) {
      const errText = await res.text().catch(() => "")
      if (isAuthFailure(res.status, res.url, ct, errText)) {
        if (allowRetry && (await this._tryRenew())) {
          return await this._openChatStream({ sessionId, messageId, workspaceId, signal, allowRetry: false })
        }
        throw new HiAgentError("HiAgent 登录态已失效，请重新登录。", {
          status: 401,
          code: "session_expired",
          signIn: true,
        })
      }
      let msg = errText || `HiAgent Chat 请求失败 (${res.status})`
      try {
        const j = JSON.parse(errText)
        msg = j?.ResponseMetadata?.Error?.Message || j?.error?.message || j?.message || msg
      } catch {}
      throw new HiAgentError(msg, { status: res.status >= 400 ? res.status : 502 })
    }
    return res
  }

  async ask(prompt, { model, maxTokens, signal, onUpdate } = {}) {
    const workspaceId = await this.discoverWorkspace({ signal })
    const modelServiceId = model?.id
    const modelName = model?.modelName || model?.name
    const publishSourceType = model?.publishSourceType || "external"
    if (!modelServiceId || !modelName) {
      throw new HiAgentError("缺少有效的 HiAgent 模型配置。", { status: 400, code: "invalid_model" })
    }

    const convRes = await this.rpc(
      "/api/aigw",
      "CreateConversation",
      {
        ConversationName: "api-proxy",
        WorkspaceID: workspaceId,
        Models: [
          {
            ModelServiceID: modelServiceId,
            ModelName: modelName,
            PublishSourceType: publishSourceType,
          },
        ],
      },
      { signal },
    )
    const convInfo = convRes?.ConversationInfo
    const conversationId = convInfo?.ConversationID
    const sessionId = convInfo?.ProjectList?.[0]?.SessionID
    if (!conversationId || !sessionId) {
      throw new HiAgentError("HiAgent CreateConversation 未返回 ConversationID 或 SessionID。", {
        status: 502,
        code: "invalid_conversation",
      })
    }

    try {
      if (Number.isFinite(maxTokens) && maxTokens > (model?.defaultMaxTokens || 32768)) {
        await this._applyMaxTokens({ conversationId, sessionId, modelServiceId, workspaceId, maxTokens, signal })
      }

      const msgRes = await this.rpc(
        "/api/aigw",
        "BatchCreateMessages",
        {
          ConversationID: conversationId,
          WorkspaceID: workspaceId,
          MessageList: [
            {
              SessionID: sessionId,
              ContentType: "text",
              Content: prompt,
            },
          ],
        },
        { signal },
      )
      const list = msgRes?.MessageList ?? []
      const messageId = list.find((m) => m?.AuthorRole === 1)?.MessageID || list[0]?.MessageID
      if (!messageId) {
        throw new HiAgentError("HiAgent BatchCreateMessages 未返回 MessageID。", {
          status: 502,
          code: "invalid_message",
        })
      }

      const chatRes = await this._openChatStream({ sessionId, messageId, workspaceId, signal })

      let text = ""
      let reasoning = ""
      const nativeCalls = new Map()
      let serverUsage = null
      let finishReason = null

      await parseSseLines(
        chatRes.body,
        (payload) => {
          let chunk
          try {
            chunk = JSON.parse(payload)
          } catch {
            return
          }
          if (chunk?.error) {
            throw new HiAgentError(chunk.error?.message || "HiAgent 模型推理错误", {
              status: 502,
              code: chunk.error?.code || "upstream_error",
            })
          }
          let deltaText = ""
          let deltaReasoning = ""
          let sawToolCall = false
          for (const c of chunk?.choices ?? []) {
            if (typeof c?.delta?.content === "string") deltaText += c.delta.content
            if (typeof c?.delta?.reasoning_content === "string") deltaReasoning += c.delta.reasoning_content
            const tcs = c?.delta?.tool_calls ?? c?.message?.tool_calls
            if (Array.isArray(tcs)) {
              for (let i = 0; i < tcs.length; i++) {
                const tc = tcs[i]
                if (!tc) continue
                const idx = Number.isInteger(tc.index) ? tc.index : i
                let entry = nativeCalls.get(idx)
                if (!entry) {
                  entry = { id: "", type: "function", function: { name: "", arguments: "" } }
                  nativeCalls.set(idx, entry)
                }
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.function.name += tc.function.name
                if (typeof tc.function?.arguments === "string") entry.function.arguments += tc.function.arguments
                sawToolCall = true
              }
            }
            if (c?.finish_reason) finishReason = c.finish_reason
          }
          if (chunk?.usage && Object.keys(chunk.usage).length) {
            serverUsage = chunk.usage
          }
          if (deltaText || deltaReasoning || sawToolCall) {
            text += deltaText
            reasoning += deltaReasoning
            onUpdate?.({ text, reasoning })
          }
        },
        signal,
      )

      const toolCalls = [...nativeCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)
        .filter((c) => c.function.name)
      return { text, reasoning, toolCalls, usage: serverUsage, finishReason }
    } finally {
      if (!this.keepHistory) {
        await this.rpc(
          "/api/aigw",
          "DeleteConversation",
          {
            ConversationID: conversationId,
            WorkspaceID: workspaceId,
          },
          { signal: AbortSignal.timeout(5000), allowRetry: false },
        ).catch(() => {})
      }
    }
  }

  async proxyOpenAI(subpath, init = {}, signal) {
    const target = `${this.origin}/api/aigw/v1${subpath}`
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${this.apiKey}`)
    headers.delete("host")
    return await this.fetchImpl(target, {
      ...init,
      headers,
      signal: signal ?? init?.signal,
    })
  }
}
