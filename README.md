# Pella 免费实例自动续期

GitHub Actions 自动领取 Pella 免费实例的 24 小时续期，结构对齐 katabump-renew。

## 两种模式

**A. 直喂模式（当前主用）**：Pella 只有 Google OAuth 登录、没有账号密码，
登录会话也无法从外部导出，所以脚本不进面板——直接对续期短链
（cuty.io / srnky.com）跑广告流程，走完后在日志里报出最终回跳链接
`FINAL_URL=`，并通过 Telegram 推送；回跳链接由带登录会话的浏览器打开
完成兑现（或平台在流程完成时已入账）。

**B. 面板模式（预留）**：注入已保存的登录会话（Playwright storageState），
打开实例页读到期时间、点续期链接、走广告流程、回面板复核到期时间。

广告页要点（实测）：有隐形全屏广告层拦截鼠标，脚本全程**键盘激活**
（focus + Enter/Space）；Turnstile 一般可通过，真正的卡点是流程在
Continue/倒计时/验证之间循环不收敛，脚本以总预算+轮次上限判定
`flow_loop` 并留截图，不无限死耗。

## 配置

仓库 Settings → Secrets and variables → Actions：

| Secret | 必填 | 说明 |
|---|---|---|
| `PELLA_CLAIM_URL` | 直喂模式二选一 | 当期续期短链（面板上 Add 24/32 Hours 的 href，每天刷新） |
| `PELLA_STORAGE_STATE` | 面板模式二选一 | Pella 已登录会话 storageState JSON 的 base64 |
| `TG_BOT_TOKEN` | 否 | 容器续期 bot 的 token（不配则只看 Actions 日志） |
| `TG_CHAT_ID` | 否 | 接收通知的会话 ID |
| `WEBSHARE_PROXY_LIST_URL` | 否 | Webshare 代理列表下载链接，需要住宅出口时再配；默认直连 |

手动运行（Actions 页 Run workflow）可临时填 `claim_url` 输入，优先于 Secret。

## 运行

- 定时：每 6 小时（UTC `30 */6 * * *`）。两种配置都没有时直接跳过。
- 手动：Actions 页 Run workflow。

## 状态（日志末尾 STATUS=）

- `destination_captured`：直喂模式走完流程，拿到回跳链接（FINAL_URL=）
- `success`：面板模式已领取，到期时间增加
- `not_ready`：面板模式续期链接未出现（未满 24 小时），不发通知
- `not_configured`：没配链接也没配会话，跳过
- `session_expired`：面板模式保存的会话过期，需重新导出更新
- `captcha_required`：某轮 Turnstile 未通过
- `flow_loop`：广告流程循环未收敛
- `claim_failed`：面板模式走了流程但到期时间未增加，看截图 Artifact 排查

## 安全

- 不要把任何 Secret 写进代码或提交到仓库；`auth.json`（运行时会话文件）
  已在 .gitignore 中，脚本结束时也会删除。
