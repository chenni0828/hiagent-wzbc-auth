// Dedicated Chrome/Edge/Chromium/Brave sign-in for HiAgent: opens an
// isolated browser profile so the user can sign in (including campus SSO /
// CAS / OAuth), reads the origin's cookies via CDP `Storage.getCookies` and
// discovers the active WorkspaceID from `/json/list` tab URLs, then closes.
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const DEFAULT_ORIGIN = "https://agent.wzbc.edu.cn"

/**
 * Resolve the directory where isolated HiAgent browser profiles are stored.
 */
export function profileRoot(env = process.env, platform = process.platform) {
  if (env.HIAGENT_BROWSER_PROFILE) return env.HIAGENT_BROWSER_PROFILE
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "hiagent-browser")
  return join(env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"), "magpie", "hiagent-browser")
}

/**
 * Locate an installed Chromium-based browser executable.
 */
export function findBrowser(platform = process.platform, env = process.env) {
  if (env.HIAGENT_BROWSER && existsSync(env.HIAGENT_BROWSER)) return env.HIAGENT_BROWSER
  const home = env.HOME || ""
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env.LOCALAPPDATA || "", "BraveSoftware/Brave-Browser/Application/brave.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
          ]
  return candidates.find((p) => p && existsSync(p)) ?? ""
}

export function browserArgs(profile, port, url, { headless = false } = {}) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    ...(headless ? ["--headless=new"] : ["--new-window"]),
    url,
  ]
}

/**
 * Extract a HiAgent personal or team workspace ID from a portal URL.
 */
export function extractWorkspaceFromUrl(url) {
  if (typeof url !== "string" || !url) return ""
  const m = url.match(/\/product\/[^/]+\/(?:personal|workspace)\/([^/?#]+)/)
  return m?.[1] ?? ""
}

/**
 * Keep cookies belonging to the target HiAgent origin's host/parent domain.
 */
export function originCookies(list, origin = DEFAULT_ORIGIN) {
  const host = new URL(origin).hostname.toLowerCase()
  const out = {}
  const sorted = [...(list ?? [])].sort((a, b) => (a?.path?.length ?? 0) - (b?.path?.length ?? 0))
  for (const c of sorted) {
    const d = String(c?.domain ?? "")
      .replace(/^\./, "")
      .toLowerCase()
    if (!d) continue
    if (d !== host && !host.endsWith("." + d)) continue
    const path = c?.path ?? "/"
    if (path !== "/" && !path.startsWith("/api")) continue
    if (typeof c.name === "string" && typeof c.value === "string") out[c.name] = c.value
  }
  return out
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function cdp(port, method, params = {}, timeout = 3000) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) =>
    r.json(),
  )
  const url = v?.webSocketDebuggerUrl
  if (!url) throw new Error("no DevTools endpoint")
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error("DevTools timed out"))
    }, timeout)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("DevTools connection failed"))
    }
    ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (m.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (m.error) reject(new Error(m.error.message || method + " failed"))
      else resolve(m.result)
    }
  })
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    child.once("exit", () => {
      clearTimeout(t)
      r()
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Launch the browser on `profile` and return a handle for reading cookies and tab URLs.
 */
export async function open(profile, url, { headless = false, origin = DEFAULT_ORIGIN, browser = findBrowser() } = {}) {
  if (!browser) {
    throw Object.assign(
      new Error("没有找到 Chrome、Edge、Chromium 或 Brave。请先安装浏览器，或设置 HIAGENT_BROWSER 环境变量。"),
      { code: "browser_missing" },
    )
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  try {
    chmodSync(profile, 0o700)
  } catch {}
  const port = await freePort()
  const child = spawn(browser, browserArgs(profile, port, url, { headless }), { stdio: "ignore", detached: false })
  let exited = false
  child.once("error", () => (exited = true))
  child.once("exit", () => (exited = true))
  return {
    get exited() {
      return exited
    },
    async cookies() {
      const r = await cdp(port, "Storage.getCookies")
      return originCookies(r?.cookies, origin)
    },
    async targets() {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) =>
        r.json(),
      )
      return Array.isArray(list) ? list : []
    },
    async close() {
      if (!exited) {
        try {
          child.kill("SIGTERM")
        } catch {}
        await waitExit(child, 2000)
      }
      if (!exited) {
        try {
          child.kill("SIGKILL")
        } catch {}
        await waitExit(child, 1000)
      }
    },
  }
}

function findSignedInWorkspace(targets, origin) {
  const originHost = new URL(origin).host.toLowerCase()
  let onPortal = false
  for (const t of targets ?? []) {
    const raw = String(t?.url ?? "")
    if (!raw.startsWith("http")) continue
    let u
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    if (u.host.toLowerCase() !== originHost) continue
    if (u.pathname.includes("/login")) continue
    const ws = extractWorkspaceFromUrl(raw)
    if (ws) return { ready: true, workspaceId: ws }
    if (u.pathname.includes("/product/")) onPortal = true
  }
  return { ready: onPortal, workspaceId: "" }
}

/**
 * Open a visible browser window at `<origin>/product/maas/` and wait for the user
 * to finish signing in. Returns `{ cookies, workspaceId, origin }` or `null`.
 */
export async function signIn(
  profile,
  { origin = DEFAULT_ORIGIN, timeout = 5 * 60_000, poll = 1000, settle = 2000, opener = open } = {},
) {
  const normalized = origin.replace(/\/+$/, "")
  const startUrl = `${normalized}/product/maas/`
  const b = await opener(profile, startUrl, { headless: false, origin: normalized })
  try {
    const end = Date.now() + timeout
    while (Date.now() < end && !b.exited) {
      const [cookies, targets] = await Promise.all([
        b.cookies().catch(() => null),
        b.targets().catch(() => null),
      ])
      if (cookies && cookies["x-csrf-token"]) {
        const hit = findSignedInWorkspace(targets, normalized)
        if (hit.ready) {
          await sleep(settle)
          const [c2, t2] = await Promise.all([
            b.cookies().catch(() => cookies),
            b.targets().catch(() => targets),
          ])
          const hit2 = findSignedInWorkspace(t2, normalized)
          return {
            cookies: c2 && Object.keys(c2).length ? c2 : cookies,
            workspaceId: hit2.workspaceId || hit.workspaceId || "",
            origin: normalized,
          }
        }
      }
      await sleep(poll)
    }
    return null
  } finally {
    await b.close()
  }
}

/**
 * Headlessly reopen the saved profile to refresh rotated session / CSRF cookies.
 */
export async function renew(
  profile,
  { origin = DEFAULT_ORIGIN, workspaceId = "", before = {}, timeout = 20_000, poll = 700, opener = open } = {},
) {
  if (!profile || !existsSync(profile)) return null
  const normalized = origin.replace(/\/+$/, "")
  const targetUrl = workspaceId
    ? `${normalized}/product/maas/personal/${encodeURIComponent(workspaceId)}/experience`
    : `${normalized}/product/maas/`
  const b = await opener(profile, targetUrl, { headless: true, origin: normalized })
  try {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end && !b.exited) {
      const [cookies, targets] = await Promise.all([
        b.cookies().catch(() => null),
        b.targets().catch(() => null),
      ])
      if (cookies && cookies["x-csrf-token"]) {
        const hit = findSignedInWorkspace(targets, normalized)
        if (hit.ready) {
          last = {
            cookies,
            workspaceId: hit.workspaceId || workspaceId || "",
            origin: normalized,
          }
          if (JSON.stringify(cookies) !== JSON.stringify(before)) return last
        }
      }
      await sleep(poll)
    }
    return last
  } finally {
    await b.close()
  }
}
