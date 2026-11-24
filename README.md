# `hiagent-wzbc-auth`

> [!IMPORTANT]
> ## 声明与使用限定
> - **仅支持温州商学院**：本插件仅面向温州商学院 HiAgent 门户（`https://agent.wzbc.edu.cn`）适配与使用，不支持其他站点或第三方实例。
> - **仅供学习交流**：本项目仅限个人技术研究、协议分析与学习交流，严禁用于商业用途、对外转售、滥用平台资源或任何违反温州商学院校规及平台服务条款的行为。使用本插件产生的一切后果由使用者自行承担。

将温州商学院 **HiAgent**（`https://agent.wzbc.edu.cn`）中已授权的大语言模型（包括 **Kimi-K3.1-Pro** 等）反代为标准 OpenAI Chat Completions 接口，作为 [Magpie](https://usemagpie.ai) 与 [OpenCode](https://opencode.ai) 的 Provider 插件使用。

---

## 在 Magpie 中安装

```sh
magpie plugin add github:chenni0828/hiagent-wzbc-auth
magpie plugin login hiagent
```

登录后即可在 Magpie 中查看并选择 `hiagent/Kimi-K3.1-Pro` 等已授权模型（支持流式输出、深度思考 `reasoning_content` 与工具调用）。

---

## 在 OpenCode 中安装

在 `opencode.json` 中添加插件：

```json
{
  "plugin": ["github:chenni0828/hiagent-wzbc-auth"]
}
```

然后执行 `opencode auth login`，选择 **HiAgent** 完成登录。

---

## 支持的三种登录方式

1. **浏览器登录 HiAgent（推荐，支持学校 SSO）**：打开隔离的 Chrome/Edge 窗口完成温州商学院统一身份认证，插件自动提取所需 Cookie（含 `x-csrf-token`）与个人空间 `WorkspaceID`；Cookie 过期时支持后台无头自动续期。
2. **手动输入浏览器 Cookie**：从浏览器开发者工具请求头复制包含 `x-csrf-token` 的完整 Cookie。
3. **HiAgent AI Gateway API Key（`/api/aigw/v1` 直连）**：若所在工作空间签发了 `aigw:key`，可选择此方式直连（注意：个人中心 `/aksk` 导出的 IAM `AccessKey ID / Secret` 不能用于 `/api/aigw/v1` 或 Web 体验反代，本插件不使用 `/aksk` 密钥）。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `HIAGENT_WORKSPACE_ID` | 手动指定 WorkspaceID | 自动识别 |
| `HIAGENT_BROWSER` | 指定 Chrome / Edge 可执行文件路径 | 自动探测 |
| `HIAGENT_BROWSER_PROFILE` | 独立浏览器配置目录 | 系统配置目录下的 `magpie/hiagent-browser` |
