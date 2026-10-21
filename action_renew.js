#!/usr/bin/env node
/**
 * Pella 免费实例自动续期（GitHub Actions / Playwright）
 *
 * 两种模式：
 * A. 直喂模式（PELLA_CLAIM_URL 有值时优先）：不进面板，直接对续期短链跑广告
 *    流程（cuty/srnky）。因为 Pella 只有 Google 登录、会话无法导出，面板模式
 *    暂时不可用；直喂模式只负责把广告流程走完并报出最终回跳链接 FINAL_URL，
 *    由带登录会话的浏览器打开回跳链接完成兑现（或平台在流程完成时已入账）。
 * B. 面板模式（PELLA_STORAGE_STATE 有值时）：注入已保存的登录会话
 *    （storageState 的 base64 JSON），打开实例页读取到期时间、点击续期链接、
 *    走广告流程、回面板复核到期时间是否增加。
 *
 * 广告页要点（实测）：有隐形全屏广告层拦截鼠标，全程键盘激活
 * （focus + Enter/Space）；Turnstile 通常可通过，真正的卡点是流程在
 * Continue/倒计时/验证之间循环不收敛——本脚本以总预算 + 轮次上限判定
 * flow_loop 并留截图，不无限死耗。
 *
 * 状态（stdout 末尾 STATUS=<状态>）：
 * - destination_captured  直喂模式走完流程，拿到回跳链接（见 FINAL_URL= 行）
 * - success               面板模式已领取且到期时间增加
 * - not_ready             面板模式续期链接暂不可用，静默
 * - not_configured        两种模式的配置都没有，跳过（退出码 0）
 * - session_expired       面板模式会话过期，需重新导出会话
 * - captcha_required      某轮 Turnstile 在预算内未通过
 * - flow_loop             广告流程循环未收敛（轮次/时间预算耗尽）
 * - claim_failed          面板模式走了流程但到期时间未增加
 * - error                 其他异常
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SERVER_URL = 'https://www.pella.app/server/fbd07b7c8b5942d8bfe6f62daf787d7e';
const SHORTENER_HOSTS = ['cuty.io', 'cuttty.com', 'srnky.com', 'shrinkearn.com', 'shrinkme.io'];
const SHOT_DIR = path.join(__dirname, 'screenshots');
const STARTED = Date.now();

let finalStatus = 'error';
let finalNote = '';
let finalUrl = '';
let lastShot = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function nowCn() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, name);
    await page.screenshot({ path: p, fullPage: false, timeout: 10000 });
    lastShot = p;
    log('截图:', name);
  } catch (e) {
    log('截图失败:', name, e.message);
  }
}

async function sendTelegram(text, photoPath) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID，跳过通知');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    log('TG 文本通知:', res.status);
  } catch (e) {
    log('TG 文本通知失败:', e.message);
  }
  if (photoPath && fs.existsSync(photoPath)) {
    try {
      const form = new FormData();
      form.append('chat_id', chat);
      form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
      log('TG 截图通知:', res.status);
    } catch (e) {
      log('TG 截图通知失败（忽略）:', e.message);
    }
  }
}

/** 把 "1D 15H 9M" / "-7 Hours 21 Minutes" / "15H 12M" 等文本解析成总分钟数 */
function parseRemainingToMinutes(text) {
  if (!text) return null;
  const m = text.match(/(?:expir\w*\s+in|expires\s+in)\s*:?\s*(-?[^.\n]+)/i);
  const seg = m ? m[1] : text;
  let sign = 1;
  let s = seg.trim();
  if (s.startsWith('-')) { sign = -1; s = s.slice(1); }
  let total = 0;
  let found = false;
  const re = /(\d+)\s*(d|days?|h|hours?|m|min(?:ute)?s?)\b/gi;
  let mm;
  while ((mm = re.exec(s)) !== null) {
    const v = parseInt(mm[1], 10);
    const u = mm[2].toLowerCase();
    if (u.startsWith('d')) total += v * 1440;
    else if (u.startsWith('h')) total += v * 60;
    else total += v;
    found = true;
  }
  return found ? sign * total : null;
}

function isShortener(url) {
  try {
    const h = new URL(url).hostname;
    return SHORTENER_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

/** 在广告页里尝试让 Turnstile 通过：聚焦复选框并空格激活，然后轮询等待 */
async function tryTurnstile(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let focused = false;
  while (Date.now() < deadline) {
    const passed = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      return !!(el && el.value && el.value.length > 10);
    }).catch(() => false);
    if (passed) { log('Turnstile 已通过'); return true; }

    if (!focused) {
      for (const f of page.frames()) {
        if (/challenges\.cloudflare\.com/.test(f.url())) {
          try {
            const cb = f.locator('input[type="checkbox"], label, body');
            await cb.first().focus({ timeout: 3000 });
            await page.keyboard.press('Space');
            focused = true;
            log('已聚焦 Turnstile 并空格激活，等待验证结果');
          } catch (e) {
            log('聚焦 Turnstile 失败:', e.message);
          }
          break;
        }
      }
      if (!focused) {
        const hasText = await page.evaluate(() =>
          /verify you are human|i am not a robot/i.test(document.body ? document.body.innerText : '')
        ).catch(() => false);
        if (hasText) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(300);
        }
      }
    }
    await page.waitForTimeout(3000);
  }
  return false;
}

/** 在广告页点主按钮：只用键盘激活（focus + Enter），不用鼠标点击 */
async function clickByKeyboard(page, labels) {
  for (const label of labels) {
    const loc = page.getByText(label, { exact: false }).first();
    try {
      if (await loc.count() === 0) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await loc.focus({ timeout: 3000 });
      await page.keyboard.press('Enter');
      log('键盘激活按钮:', label);
      return label;
    } catch (e) {
      // 换下一个候选
    }
  }
  return null;
}

const ACTION_LABELS = ['Continue', 'I am not a robot', "I'm not a robot", 'Go ->', 'Go →', 'Get Link', 'Click here to continue', 'Click here', 'Next', 'Proceed'];

/**
 * 走广告短链流程。收敛判定：当前页离开短链域名（回跳）或出现新页面且其
 * URL 不在短链域名上。返回 true 表示已收敛（finalUrl 已记录）。
 */
async function runAdFlow(adPage, tag, budgetMs) {
  const context = adPage.context();
  const deadline = Date.now() + budgetMs;
  let step = 0;
  let rounds = 0;
  const MAX_ROUNDS = 14;

  const checkConverged = async () => {
    for (const p of context.pages()) {
      const u = p.url();
      if (u && u !== 'about:blank' && !isShortener(u)) {
        finalUrl = u;
        return true;
      }
    }
    return false;
  };

  while (Date.now() < deadline) {
    if (await checkConverged()) { log(tag, '已收敛到回跳地址:', finalUrl); return true; }
    if (adPage.isClosed()) {
      // 广告页关了但可能留下了目标页
      if (await checkConverged()) { log(tag, '广告页关闭后发现回跳地址:', finalUrl); return true; }
      log(tag, '广告页已关闭且无回跳地址');
      return false;
    }
    step += 1;
    await adPage.waitForTimeout(2500);
    if (step % 3 === 1) await shot(adPage, `${tag}-step${step}.png`);
    const url = adPage.url();
    log(tag, `第${step}步 当前页:`, url);
    if (!isShortener(url)) { finalUrl = url; log(tag, '已离开短链域名:', url); return true; }

    const content = await adPage.content().catch(() => '');
    const text = await adPage.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/verify you are human|checking your browser|just a moment/i.test(text) ||
        /challenges\.cloudflare\.com/.test(content)) {
      rounds += 1;
      log(tag, `第 ${rounds} 轮人机验证`);
      if (rounds > MAX_ROUNDS) {
        finalStatus = 'flow_loop';
        finalNote = `${tag} 已过 ${MAX_ROUNDS} 轮验证仍未收敛`;
        return false;
      }
      const ok = await tryTurnstile(adPage, 90000);
      if (!ok) { finalStatus = 'captcha_required'; finalNote = `${tag} 第 ${rounds} 轮 Turnstile 未通过`; return false; }
      // 真人节奏：验证通过后稍等再继续
      await adPage.waitForTimeout(3000 + Math.floor(Math.random() * 3000));
      continue;
    }
    if (/please wait/i.test(text)) {
      log(tag, '倒计时中，等待…');
      await adPage.waitForTimeout(8000);
      continue;
    }
    const clicked = await clickByKeyboard(adPage, ACTION_LABELS);
    if (!clicked) {
      log(tag, '未找到可激活按钮，等待页面变化');
      await adPage.waitForTimeout(5000);
    } else {
      await adPage.waitForTimeout(4000);
    }
  }
  if (await checkConverged()) { log(tag, '预算结束时已收敛:', finalUrl); return true; }
  finalStatus = 'flow_loop';
  finalNote = `${tag} 广告流程在 ${Math.round(budgetMs / 60000)} 分钟预算内未收敛（共 ${rounds} 轮验证）`;
  return false;
}

function proxyOption() {
  return process.env.PROXY_SERVER
    ? { server: process.env.PROXY_SERVER, username: process.env.PROXY_USER || undefined, password: process.env.PROXY_PASS || undefined }
    : undefined;
}

async function getEgressIp(context) {
  try {
    const r = await context.request.get('https://api.ipify.org?format=json', { timeout: 15000 });
    const j = await r.json();
    if (j && j.ip) return j.ip;
  } catch (e) { log('出口 IP 获取失败（忽略）'); }
  return '未知';
}

/** 直喂模式：只跑广告流程，报出回跳链接 */
async function runClaimMode(browser, claimUrl) {
  const context = await browser.newContext({ proxy: proxyOption() });
  const page = await context.newPage();
  const egressIp = await getEgressIp(context);
  log('出口 IP:', egressIp);
  log('直喂模式，目标短链:', claimUrl);
  await page.goto(claimUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const tag = /srnky/i.test(claimUrl) ? 'srnky' : 'cuty';
  const ok = await runAdFlow(page, tag, 18 * 60 * 1000);
  const elapsed = Math.round((Date.now() - STARTED) / 1000);
  if (ok && finalUrl) {
    finalStatus = 'destination_captured';
    finalNote = `广告流程已走完，用时 ${elapsed} 秒`;
    await sendTelegram(
      `🟡 Pella 广告流程已在 GitHub 环境走完\n🌐 出口IP: ${egressIp}\n🔗 回跳链接: ${finalUrl}\n⚡️ 脚本耗时: ${elapsed}秒\n🕐 执行时间: ${nowCn()}\n\n回跳链接需由带登录会话的浏览器打开兑现，蛋子会跟进确认到期时间。`,
      lastShot
    );
  } else {
    if (finalStatus !== 'flow_loop' && finalStatus !== 'captcha_required') {
      finalStatus = 'flow_loop';
      finalNote = finalNote || '广告流程未走完且未拿到回跳链接';
    }
    await sendTelegram(
      `❌ Pella 续期失败（GitHub 直喂模式）\n🌐 出口IP: ${egressIp}\n⚠️ 原因: ${finalNote}\n🕐 执行时间: ${nowCn()}`,
      lastShot
    );
  }
}

async function readPanelState(page) {
  await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 续期链接从 "Updating..." 变为可用文案可能需要较久，最多等 90 秒
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(10000);
    const t = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/add\s*(24|32)\s*hours/i.test(t) || /\/login|\/signin/.test(page.url())) break;
  }
  const url = page.url();
  const text = await page.evaluate(() => document.body ? document.body.innerText : '');
  const loggedOut = /\/login|\/signin|\/auth/.test(url) ||
    (/continue with google|sign in with google/i.test(text) && !/expires/i.test(text));
  const expiryMatch = text.match(/(?:expires?\s+in|expiring\s+in)\s*:?\s*-?[^\n.]+/i);
  return {
    url,
    loggedOut,
    expiryText: expiryMatch ? expiryMatch[0].trim() : null,
    minutes: parseRemainingToMinutes(text),
    has24: /add\s*24\s*hours/i.test(text),
    has32: /add\s*32\s*hours/i.test(text),
    running: /running/i.test(text),
  };
}

/** 面板模式：注入会话 → 读到期 → 点链接走流程 → 复核 */
async function runPanelMode(browser, stateJson) {
  const authPath = path.join(__dirname, 'auth.json');
  fs.writeFileSync(authPath, stateJson);
  try {
    const context = await browser.newContext({ storageState: authPath, proxy: proxyOption() });
    const page = await context.newPage();
    const egressIp = await getEgressIp(context);
    log('出口 IP:', egressIp);

    const before = await readPanelState(page);
    await shot(page, 'panel-before.png');
    log('面板状态:', JSON.stringify(before));
    if (before.loggedOut) {
      finalStatus = 'session_expired';
      finalNote = '会话已过期，被重定向到登录页';
      await sendTelegram(
        `❌ Pella 续期失败\n👤 登录账号: j***m\n🌐 出口IP: ${egressIp}\n⚠️ 原因: 保存的登录会话已过期，需要重新导出会话后更新 PELLA_STORAGE_STATE\n🕐 执行时间: ${nowCn()}`,
        lastShot
      );
      return;
    }

    const linkTexts = [];
    if (before.has24) linkTexts.push('Add 24 Hours');
    if (before.has32) linkTexts.push('Add 32 Hours');
    if (linkTexts.length === 0) {
      finalStatus = 'not_ready';
      finalNote = `续期链接未出现（到期文本: ${before.expiryText || '未读到'}）`;
      log(finalNote);
      return;
    }

    let flowOk = false;
    for (const label of linkTexts) {
      log('尝试领取:', label);
      const link = page.getByText(new RegExp(label.replace(/\s+/g, '\\s*'), 'i')).first();
      const popupPromise = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
      await link.focus({ timeout: 5000 }).catch(() => {});
      await page.keyboard.press('Enter');
      const adPage = await popupPromise;
      if (!adPage) {
        await page.waitForTimeout(5000);
        if (isShortener(page.url())) {
          flowOk = await runAdFlow(page, label.includes('24') ? 'cuty' : 'srnky', 10 * 60 * 1000);
        }
      } else {
        await adPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        flowOk = await runAdFlow(adPage, label.includes('24') ? 'cuty' : 'srnky', 10 * 60 * 1000);
      }
      if (flowOk) break;
      if (finalStatus === 'captcha_required' || finalStatus === 'flow_loop') {
        log(label, `未走完（${finalStatus}），尝试下一条链接`);
        finalStatus = 'error';
        continue;
      }
    }

    await page.bringToFront().catch(() => {});
    const after = await readPanelState(page);
    await shot(page, 'panel-after.png');
    log('领取后面板状态:', JSON.stringify(after));
    const elapsed = Math.round((Date.now() - STARTED) / 1000);

    if (before.minutes !== null && after.minutes !== null && after.minutes > before.minutes) {
      finalStatus = 'success';
      finalNote = `到期 ${before.expiryText} → ${after.expiryText}`;
      await sendTelegram(
        `✅ Pella 续期成功\n👤 登录账号: j***m\n🌐 出口IP: ${egressIp}\n📅 到期时间: ${after.expiryText || '未知'}\n🖥️ 机器状态: ${after.running ? 'RUNNING' : '未知'}\n⏳ 运行时长: 约${Math.round((after.minutes || 0) / 60 * 10) / 10}小时\n⚡️ 脚本耗时: ${elapsed}秒\n🕐 执行时间: ${nowCn()}`,
        lastShot
      );
    } else {
      finalStatus = 'claim_failed';
      finalNote = `到期时间未增加（${before.expiryText || '?'} → ${after.expiryText || '?'}）`;
      await sendTelegram(
        `❌ Pella 续期失败\n👤 登录账号: j***m\n🌐 出口IP: ${egressIp}\n⚠️ 原因: ${finalNote}\n🕐 执行时间: ${nowCn()}\n\n请手动打开面板领取：${SERVER_URL}`,
        lastShot
      );
    }
  } finally {
    try { fs.unlinkSync(authPath); } catch (e) {}
  }
}

async function main() {
  const claimUrl = (process.env.PELLA_CLAIM_URL || '').trim();
  const rawState = (process.env.PELLA_STORAGE_STATE || '').trim();
  if (!claimUrl && !rawState) {
    console.log('STATUS=not_configured');
    console.log('NOTE=未配置 PELLA_CLAIM_URL 或 PELLA_STORAGE_STATE，跳过');
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    if (claimUrl) {
      await runClaimMode(browser, claimUrl);
    } else {
      let stateJson;
      try {
        stateJson = Buffer.from(rawState, 'base64').toString('utf8');
        JSON.parse(stateJson);
      } catch (e) {
        stateJson = rawState;
        JSON.parse(stateJson);
      }
      await runPanelMode(browser, stateJson);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error('FATAL:', e && e.stack ? e.stack : e);
    if (finalStatus === 'error' || !finalStatus) {
      finalStatus = 'error';
      finalNote = String(e && e.message ? e.message : e);
    }
  })
  .finally(async () => {
    if (finalStatus === 'error' && finalNote) {
      await sendTelegram(`❌ Pella 续期失败\n⚠️ 原因: ${finalNote}\n🕐 执行时间: ${nowCn()}`, lastShot).catch(() => {});
    }
    console.log(`STATUS=${finalStatus}`);
    console.log(`NOTE=${finalNote}`);
    if (finalUrl) console.log(`FINAL_URL=${finalUrl}`);
    const okExit = ['success', 'not_ready', 'not_configured', 'destination_captured'].includes(finalStatus);
    process.exit(okExit ? 0 : 1);
  });
