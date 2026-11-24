// HiAgent OpenCode & Magpie provider plugin.
// Exposes granted HiAgent text-generation models (including Kimi-K3.1-Pro)
// through an OpenAI-compatible fetch loader backed by either:
// 1) HiAgent Web Experience session cookies + x-csrf-token, or
// 2) HiAgent AI Gateway API Key (/api/aigw/v1).
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { profileRoot, renew, signIn } from "./browser.mjs"
import {
  DEFAULT_MODELS,
  DEFAULT_ORIGIN,
  HiAgentError,
  Session,
  parseCookieHeader,
} from "./hiagent.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "hiagent"
const BASE = "https://hiagent-web.invalid/v1"

const jsonError = (status, message, type = "hiagent_error") =>
  new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/**
 * Convert an internal HiAgent model entry into the OpenCode / Magpie model row shape.
 */
export function toModelRow(m) {
  return {
    name: m.name || m.modelName,
    limit: { context: m.context || 256000, output: m.maxOutput || 102400 },
    tool_call: m.toolCall !== false,
    reasoning: !!m.reasoning,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      reasoning: !!m.reasoning,
      toolcall: m.toolCall !== false,
      attachment: false,
      input: { text: true, image: false },
      output: { text: true },
    },
  }
}

function modelsMap(table) {
  const out = {}
  for (const [id, m] of Object.entries(table ?? {})) {
    out[id] = toModelRow(m)
  }
  return out
}

function normalizeOrigin(raw) {
  const s = String(raw ?? "").trim() || DEFAULT_ORIGIN
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).origin
  } catch {
    return DEFAULT_ORIGIN
  }
}

/**
 * Decode stored credential JSON or raw Cookie / API Key strings from auth.json.
 */
export function parseStoredAuth(auth) {
  const raw = auth?.access || auth?.key
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      const origin = normalizeOrigin(parsed?.origin)
      if (parsed?.mode === "apikey" || (parsed?.apiKey && !parsed?.cookies)) {
        const apiKey = String(parsed.apiKey || "").trim()
        return apiKey ? { mode: "apikey", origin, apiKey } : null
      }
      if (parsed?.cookies && typeof parsed.cookies === "object") {
        return {
          mode: "web",
          origin,
          workspaceId: String(parsed.workspaceId || ""),
          cookies: parsed.cookies,
        }
      }
    } catch {
      return null
    }
  }

  if (trimmed.includes("=") && (trimmed.includes(";") || trimmed.includes("x-csrf-token="))) {
    const cookies = parseCookieHeader(trimmed)
    if (cookies["x-csrf-token"]) {
      return {
        mode: "web",
        origin: normalizeOrigin(process.env.HIAGENT_ORIGIN),
        workspaceId: String(process.env.HIAGENT_WORKSPACE_ID || ""),
        cookies,
      }
    }
  }

  return {
    mode: "apikey",
    origin: normalizeOrigin(process.env.HIAGENT_ORIGIN),
    apiKey: trimmed,
  }
}

function resolveModel(table, requestedId) {
  const clean = String(requestedId || "Kimi-K3.1-Pro").replace(/^hiagent\//i, "")
  if (table[clean]) return { id: clean, model: table[clean] }
  const lower = clean.toLowerCase()
  for (const [k, m] of Object.entries(table)) {
    if (k.toLowerCase() === lower || String(m.id).toLowerCase() === lower) {
      return { id: k, model: m }
    }
  }
  return { id: clean, model: null }
}

async function readBodyText(request, init) {
  if (request) return await request.text()
  if (typeof init?.body === "string") return init.body
  if (init?.body == null) return ""
  return await new Response(init.body).text()
}

export function createPlugin({
  client,
  fetchImpl = globalThis.fetch,
  newId,
  browser = { signIn, renew, profileRoot },
  keepHistory = false,
} = {}) {
  const sessions = new Map()
  const catalogs = new Map()

  const sessionFor = (auth) => {
    const parsed = parseStoredAuth(auth)
    const key = auth?.accountId || (parsed ? JSON.stringify(parsed) : "anonymous")
    let s = sessions.get(key)
    if (s && s.storedRaw !== (auth?.access || auth?.key) && s.writtenRaw !== (auth?.access || auth?.key)) {
      s = null
    }
    if (!s) {
      const origin = parsed?.origin || DEFAULT_ORIGIN
      const workspaceId = parsed?.workspaceId || ""
      const canRenew = parsed?.mode === "web" && !!auth?.refresh
      s = new Session({
        origin,
        workspaceId,
        cookies: parsed?.mode === "web" ? parsed.cookies : null,
        apiKey: parsed?.mode === "apikey" ? parsed.apiKey : "",
        fetchImpl,
        keepHistory,
        renew: canRenew
          ? () =>
              browser.renew(auth.refresh, {
                origin,
                workspaceId: s.workspaceId || workspaceId,
                before: s.cookies ?? {},
              })
          : null,
        onCookies: (cookies, wsId) => {
          if (!cookies || parsed?.mode !== "web") return
          const payload = JSON.stringify({
            mode: "web",
            origin,
            workspaceId: wsId || workspaceId,
            cookies,
          })
          s.writtenRaw = payload
          const body =
            auth?.type === "api"
              ? { type: "api", key: payload }
              : {
                  type: "oauth",
                  access: payload,
                  refresh: auth?.refresh ?? "",
                  expires: 0,
                  accountId: auth?.accountId,
                  name: auth?.name,
                }
          client?.auth?.set?.({ path: { id: ID }, body })?.catch?.(() => {})
        },
      })
      s.storedRaw = auth?.access || auth?.key || ""
      sessions.set(key, s)
    }
    return { key, s }
  }

  const listFor = async (auth) => {
    const { key, s } = sessionFor(auth)
    if (!s.signedIn) return { table: DEFAULT_MODELS, read: false }
    try {
      const table = await s.listModels({ signal: AbortSignal.timeout(20000) })
      if (Object.keys(table).length) {
        catalogs.set(key, table)
        return { table, read: true }
      }
    } catch {}
    return { table: catalogs.get(key) ?? DEFAULT_MODELS, read: catalogs.has(key) }
  }

  const mapError = (e) => {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
    if (e?.signIn) throw Object.assign(new Error(e.message), { signIn: "expired" })
    return jsonError(e?.status ?? 502, String(e?.message ?? e), e?.code ?? "hiagent_error")
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {
        name: "HiAgent",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
      }
      cfg.provider[ID].models = {
        ...modelsMap(DEFAULT_MODELS),
        ...(cfg.provider[ID].models ?? {}),
      }
    },

    provider: {
      id: ID,
      async models(_given, { auth } = {}) {
        const { table, read } = await listFor(auth)
        const out = modelsMap(table)
        if (!read) out[Symbol.for("magpie.fellBack")] = true
        return out
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 4,
      methods: [
        {
          type: "oauth",
          label: "浏览器登录 HiAgent（推荐，支持学校 SSO）",
          authorize: async () => ({
            url: "",
            method: "auto",
            instructions:
              "将打开一个单独的浏览器窗口（独立配置，不影响你平时的浏览器）。请在其中登录 HiAgent（如学校统一身份认证），进入个人空间后窗口会自动关闭。",
            callback: async () => {
              const origin = normalizeOrigin(process.env.HIAGENT_ORIGIN)
              const profile = join(browser.profileRoot(), randomBytes(6).toString("hex"))
              let res
              try {
                res = await browser.signIn(profile, { origin })
              } catch (e) {
                return { type: "failed", error: "打开浏览器失败：" + String(e?.message ?? e) }
              }
              if (!res?.cookies || !res.cookies["x-csrf-token"]) {
                return { type: "failed", error: "五分钟内未完成 HiAgent 登录，请重试。" }
              }
              const s = new Session({
                origin: res.origin || origin,
                workspaceId: res.workspaceId || "",
                cookies: res.cookies,
                fetchImpl,
              })
              let models
              try {
                models = await s.listModels({ signal: AbortSignal.timeout(20000) })
              } catch (e) {
                return { type: "failed", error: "登录后读取 HiAgent 模型列表失败：" + String(e?.message ?? e) }
              }
              const ws = s.workspaceId || res.workspaceId || "default"
              const host = new URL(origin).hostname
              const label = `${host} (${ws})`
              return {
                type: "success",
                access: JSON.stringify({
                  mode: "web",
                  origin: s.origin,
                  workspaceId: ws,
                  cookies: res.cookies,
                }),
                refresh: profile,
                expires: 0,
                accountId: `${host}:${ws}`,
                name: label,
                metadata: { name: label, modelCount: Object.keys(models).length },
              }
            },
          }),
        },
        {
          type: "api",
          label: "手动输入浏览器 Cookie（支持自定义 HiAgent 地址）",
          prompts: [
            {
              type: "text",
              key: "origin",
              message: "HiAgent 站点地址（默认 https://agent.wzbc.edu.cn）",
              placeholder: DEFAULT_ORIGIN,
              required: false,
            },
            {
              type: "text",
              key: "workspaceId",
              message: "WorkspaceID（可选，URL 中 personal-xxx，留空自动识别）",
              placeholder: "personal-xxxxxxxxxxxxxxxxxxxx",
              required: false,
            },
            {
              type: "text",
              key: "cookie",
              message: "从浏览器请求头复制完整的 Cookie（必须包含 x-csrf-token）",
              placeholder: "x-csrf-token=...; ...",
            },
          ],
          authorize: async (inputs = {}) => {
            const origin = normalizeOrigin(inputs.origin)
            const workspaceId = String(inputs.workspaceId || "").trim()
            const cookies = parseCookieHeader(inputs.cookie)
            if (!cookies["x-csrf-token"]) {
              return {
                type: "failed",
                error: "Cookie 中缺少 x-csrf-token 字段，请从浏览器开发者工具 Request Headers 中复制完整 Cookie。",
              }
            }
            const s = new Session({ origin, workspaceId, cookies, fetchImpl })
            try {
              await s.listModels({ signal: AbortSignal.timeout(20000) })
            } catch (e) {
              return { type: "failed", error: "Cookie 验证失败：" + String(e?.message ?? e) }
            }
            const ws = s.workspaceId || workspaceId || "default"
            const host = new URL(origin).hostname
            const label = `${host} (${ws})`
            return {
              type: "success",
              key: JSON.stringify({ mode: "web", origin, workspaceId: ws, cookies }),
              accountId: `${host}:${ws}`,
              name: label,
              metadata: { name: label },
            }
          },
        },
        {
          type: "api",
          label: "HiAgent AI Gateway API Key（/api/aigw/v1 直连）",
          prompts: [
            {
              type: "text",
              key: "origin",
              message: "HiAgent 站点地址（默认 https://agent.wzbc.edu.cn）",
              placeholder: DEFAULT_ORIGIN,
              required: false,
            },
            {
              type: "text",
              key: "apiKey",
              message: "输入 AI Gateway API Key（aigw:key，注意：非个人中心 /aksk 密钥）",
              placeholder: "sk-...",
            },
          ],
          authorize: async (inputs = {}) => {
            const origin = normalizeOrigin(inputs.origin)
            const apiKey = String(inputs.apiKey || "").trim()
            if (!apiKey) return { type: "failed", error: "API Key 不能为空。" }
            const s = new Session({ origin, apiKey, fetchImpl })
            try {
              await s.listModels({ signal: AbortSignal.timeout(20000) })
            } catch (e) {
              return { type: "failed", error: "API Key 验证失败：" + String(e?.message ?? e) }
            }
            const host = new URL(origin).hostname
            return {
              type: "success",
              key: JSON.stringify({ mode: "apikey", origin, apiKey }),
              accountId: `${host}:apikey`,
              name: `${host} (API Key)`,
              metadata: { name: `${host} (API Key)` },
            }
          },
        },
      ],

      loader: async (getAuth) => ({
        baseURL: BASE,
        apiKey: "hiagent",
        async fetch(input, init = {}) {
          const request = input instanceof Request ? new Request(input, init) : null
          const url = new URL(request ? request.url : String(input))
          const method = (request ? request.method : init.method ?? "GET").toUpperCase()
          const signal = request ? request.signal : init.signal
          const baseOrigin = new URL(BASE).origin
          if (url.origin !== baseOrigin) {
            return jsonError(404, "不支持的请求目标。", "not_found")
          }

          const auth = await getAuth()
          const { key, s } = sessionFor(auth)
          if (!s.signedIn) {
            throw Object.assign(new Error("尚未登录 HiAgent，请先运行登录。"), { signIn: "expired" })
          }

          if (url.pathname.endsWith("/models") && method === "GET") {
            try {
              const table = await s.listModels({ signal })
              if (Object.keys(table).length) catalogs.set(key, table)
              const data = Object.keys(table).map((id) => ({
                id,
                object: "model",
                created: 0,
                owned_by: "hiagent",
              }))
              return Response.json({ object: "list", data })
            } catch (e) {
              return mapError(e)
            }
          }

          if (s.mode === "apikey") {
            const prefix = new URL(BASE).pathname.replace(/\/+$/, "")
            const subpath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
            const rawBody = method === "GET" || method === "HEAD" ? undefined : await readBodyText(request, init)
            return await s.proxyOpenAI(subpath + url.search, {
              method,
              headers: request ? request.headers : init.headers,
              body: rawBody,
              signal,
            })
          }

          if (!url.pathname.endsWith("/chat/completions") || method !== "POST") {
            return jsonError(404, "HiAgent 网页代理仅支持 /v1/models 与 /v1/chat/completions。", "not_found")
          }

          let body
          try {
            body = JSON.parse(await readBodyText(request, init))
          } catch {
            return jsonError(400, "请求体不是合法的 JSON。", "invalid_request_error")
          }

          let table = catalogs.get(key) ?? DEFAULT_MODELS
          let resolved = resolveModel(table, body.model)
          if (!resolved.model) {
            try {
              const fresh = await s.listModels({ signal })
              if (Object.keys(fresh).length) {
                catalogs.set(key, fresh)
                table = fresh
              }
            } catch (e) {
              if (e?.signIn) return mapError(e)
            }
            resolved = resolveModel(table, body.model)
          }

          if (!resolved.model) {
            return jsonError(
              404,
              `当前 HiAgent 工作空间没有可用模型 "${body.model}"。可用模型：${Object.keys(table).join("、")}`,
              "model_not_found",
            )
          }

          const prompt = flatten(body)
          const parseTools = Array.isArray(body?.tools) && body.tools.length > 0 && body?.tool_choice !== "none"
          const id = "chatcmpl-" + Math.random().toString(36).slice(2)
          const promptTokens = () => Math.ceil(prompt.length / 3)
          const maxTokens = body.max_completion_tokens ?? body.max_tokens

          try {
            if (body.stream) {
              return await sse({
                id,
                model: resolved.id,
                signal,
                newId,
                parseTools,
                promptTokens,
                ask: (onUpdate, sig) =>
                  s.ask(prompt, { model: resolved.model, maxTokens, signal: sig, onUpdate }),
              })
            }
            const final = await s.ask(prompt, { model: resolved.model, maxTokens, signal })
            return Response.json(
              completion({ id, model: resolved.id, final, promptTokens: promptTokens(), newId, parseTools }),
            )
          } catch (e) {
            return mapError(e)
          }
        },
      }),
    },
  }
}

export default async function HiAgentProvider({ client } = {}) {
  return createPlugin({ client })
}

export const _internal = { createPlugin, parseStoredAuth, toModelRow, BASE, ID }
