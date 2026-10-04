import "dotenv/config";
import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import { Bot, session, webhookCallback } from "grammy";

/* ---------- CONFIG ---------- */
// Версия БЕЗ юзербот-сессии — только Bot API. Из-за этого ограничения:
// "массовый кик по списку оставшихся" невозможен (Bot API не умеет
// перечислять участников чата), поэтому ниже вместо него — кик по
// явному списку ID / пересланным сообщениям, это Bot API умеет.
// Когда появится SESSION_STRING — вернём полноценный whitelist-режим.

function env(name, required = true) {
  const val = process.env[name] ?? "";
  if (required && !val) throw new Error(`Переменная окружения ${name} не задана`);
  return val;
}

const BOT_TOKEN = env("BOT_TOKEN");
const KICK_DELAY_MS = Number(env("KICK_DELAY_MS", false) || "300"); // пауза между кик-запросами

// Вебхук/анти-слип — по желанию, тот же паттерн, что в прошлых ботах.
const PORT = Number(process.env.PORT || 10000);
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "";
const USE_WEBHOOK = Boolean(EXTERNAL_URL);
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");

/* ---------- RAW BOT API (цветные кнопки) ---------- */

const API_ROOT = `https://api.telegram.org/bot${BOT_TOKEN}`;

function button(text, callback_data, style) {
  return style ? { text, callback_data, style } : { text, callback_data };
}

function keyboard(rows) {
  return { inline_keyboard: rows };
}

async function apiPost(method, payload) {
  const res = await fetch(`${API_ROOT}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error on ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendMessage(chatId, text, replyMarkup) {
  return apiPost("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  return apiPost("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : { reply_markup: { inline_keyboard: [] } }),
  });
}

async function banChatMember(chatId, userId) {
  return apiPost("banChatMember", { chat_id: chatId, user_id: userId });
}

async function unbanChatMember(chatId, userId) {
  return apiPost("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
}

/** "Кик" в Bot API — это бан + мгновенный разбан: человек выходит, но не блокируется навсегда. */
async function kickMember(chatId, userId) {
  await banChatMember(chatId, userId);
  await unbanChatMember(chatId, userId);
}

/** Кик с ретраем при лимите от Bot API (retry_after в ответе) — ждёт и повторяет, а не просто пропускает. */
async function kickMemberWithRetry(chatId, userId, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await kickMember(chatId, userId);
      return true;
    } catch (e) {
      const retryAfterMatch = String(e.message).match(/"retry_after":(\d+)/);
      if (retryAfterMatch && attempt < maxRetries) {
        const waitSec = Number(retryAfterMatch[1]);
        console.warn(`⚠️ Лимит Bot API: жду ${waitSec} сек перед повтором (user ${userId})`);
        await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
        continue;
      }
      console.warn(`⚠️ Не удалось выгнать ${userId} из ${chatId}: ${e.message}`);
      return false;
    }
  }
  return false;
}

function userLabel(u) {
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  return `${name || "без имени"} (${u.id})`;
}

/** Достаёт id отправителя из пересланного сообщения (учитывает оба формата Bot API). */
function extractForwardedUserId(message) {
  const origin = message.forward_origin;
  if (origin && origin.type === "user" && origin.sender_user) return origin.sender_user.id;
  if (message.forward_from) return message.forward_from.id;
  return null;
}

/* ---------- ХРАНЕНИЕ (JSON-файлы рядом с ботом) ---------- */

const PROTECTED_FILE = process.env.PROTECTED_FILE || "protected_chats.json";
const PENDING_FILE = process.env.PENDING_FILE || "pending_links.json";

let protectedChats = {}; // chatId -> { ownerId, title, antiRaid }
let pendingLinks = {}; // userId -> { chatId, title }

try {
  protectedChats = JSON.parse(fs.readFileSync(PROTECTED_FILE, "utf8"));
} catch {
  /* файла ещё нет */
}
try {
  pendingLinks = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
} catch {
  /* файла ещё нет */
}

function saveProtected() {
  try {
    fs.writeFileSync(PROTECTED_FILE, JSON.stringify(protectedChats));
  } catch (e) {
    console.warn(`⚠️ Не удалось сохранить protected_chats: ${e.message}`);
  }
}

function savePending() {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingLinks));
  } catch (e) {
    console.warn(`⚠️ Не удалось сохранить pending_links: ${e.message}`);
  }
}

/* ---------- ТЕКСТЫ И КЛАВИАТУРЫ ---------- */

const WELCOME_TEXT =
  "Добро пожаловать в Stop Abuse 🛡️\n\n" +
  "Пришлите ссылку на свой чат или канал — разберёмся, как защитить его от накрутки.";

function tutorialText(title) {
  return (
    `«${title}» найден.\n\n` +
    "Чтобы включить защиту, добавьте бота туда администратором с правами:\n" +
    "— Блокировка пользователей\n" +
    "— Добавление участников\n\n" +
    "Как только права будут выданы, здесь появится панель управления."
  );
}

function tutorialTextPrivateFallback(input) {
  return (
    `Не нашёл «${input}» напрямую — скорее всего, это приватный чат без публичного юзернейма.\n\n` +
    "Ничего страшного: просто добавьте бота туда администратором с правами (блокировка пользователей, добавление участников) — " +
    "панель управления появится здесь сама, как только права будут выданы."
  );
}

function controlKeyboard(chatId, antiRaidOn) {
  return keyboard([
    [button(antiRaidOn ? "🛡️ Анти-накрут: включён" : "Анти-накрут: выключен", `toggle:${chatId}`, antiRaidOn ? "success" : undefined)],
    [button("Выгнать по списку", `kicklist:${chatId}`, "danger")],
    [button("Информация о чате", `chatinfo:${chatId}`)],
  ]);
}

function controlPanelText(title) {
  return `«${title}» — панель управления`;
}

/* ---------- ИЗВЛЕЧЕНИЕ ИДЕНТИФИКАТОРА ЧАТА ИЗ ССЫЛКИ ---------- */

function extractChatIdentifier(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/(?:https?:\/\/)?t\.me\/(\w[\w\d_]*)/i);
  if (m) return `@${m[1]}`;
  if (trimmed.startsWith("@")) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}

/* ---------- BOT ---------- */

const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({ waitingChatLink: false, kickListChatId: null }) }));

let BOT_ID = null;

bot.command("start", async (ctx) => {
  ctx.session.waitingChatLink = true;
  ctx.session.kickListChatId = null;
  await sendMessage(ctx.chat.id, WELCOME_TEXT);
});

bot.command("cancel", async (ctx) => {
  ctx.session.waitingChatLink = false;
  ctx.session.kickListChatId = null;
  await sendMessage(ctx.chat.id, "Отменено.");
});

// Список всех чатов, которыми владеет этот пользователь — чтобы не терять
// панель управления, если сообщение с ней затерялось выше по переписке.
bot.command("panel", async (ctx) => {
  const mine = Object.entries(protectedChats).filter(([, p]) => p.ownerId === ctx.from.id);
  if (mine.length === 0) {
    await sendMessage(ctx.chat.id, "У вас пока нет защищённых чатов. Пришлите /start, чтобы подключить первый.");
    return;
  }
  if (mine.length === 1) {
    const [chatId, p] = mine[0];
    await sendMessage(ctx.chat.id, controlPanelText(p.title), controlKeyboard(Number(chatId), p.antiRaid));
    return;
  }
  const rows = mine.map(([chatId, p]) => [button(p.title, `openpanel:${chatId}`)]);
  await sendMessage(ctx.chat.id, "Выберите чат:", keyboard(rows));
});

bot.callbackQuery(/^openpanel:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, controlPanelText(p.title), controlKeyboard(chatId, p.antiRaid));
  await ctx.answerCallbackQuery();
});

// Общий обработчик текста/пересылок: сначала режим кика по списку (если
// включён), потом привязка чата по ссылке.
bot.on("message", async (ctx) => {
  const isCommand = ctx.message.text && ctx.message.text.startsWith("/");
  if (isCommand) return;

  if (ctx.session.kickListChatId) {
    const chatId = ctx.session.kickListChatId;
    const p = protectedChats[chatId];
    if (!p) {
      await sendMessage(ctx.chat.id, "Этот чат больше не под защитой бота.");
      ctx.session.kickListChatId = null;
      return;
    }

    const ids = new Set();
    const text = ctx.message.text || ctx.message.caption || "";
    for (const tok of text.split(/\s+/)) {
      if (/^\d+$/.test(tok)) ids.add(Number(tok));
    }
    const fwdId = extractForwardedUserId(ctx.message);
    if (fwdId) ids.add(fwdId);

    if (ids.size === 0) {
      await sendMessage(ctx.chat.id, "Не нашёл ни одного ID — пришлите числа через пробел или перешлите сюда сообщение нужного человека. Для выхода — /cancel.");
      return;
    }

    const lines = [];
    for (const id of ids) {
      const ok = await kickMemberWithRetry(chatId, id);
      lines.push(`${id} — ${ok ? "выгнан" : "не удалось (возможно, не состоит в чате)"}`);
      await new Promise((r) => setTimeout(r, KICK_DELAY_MS));
    }
    await sendMessage(ctx.chat.id, lines.join("\n") + "\n\nМожно продолжать присылать ID/пересылки, либо /cancel для выхода.");
    return;
  }

  if (ctx.session.waitingChatLink && ctx.message.text) {
    ctx.session.waitingChatLink = false;
    const raw = ctx.message.text.trim();
    const identifier = extractChatIdentifier(raw);

    let chat;
    try {
      chat = await bot.api.getChat(identifier);
    } catch {
      pendingLinks[ctx.from.id] = { chatId: null, title: raw };
      savePending();
      await sendMessage(ctx.chat.id, tutorialTextPrivateFallback(raw));
      return;
    }

    pendingLinks[ctx.from.id] = { chatId: chat.id, title: chat.title || chat.username || raw };
    savePending();
    await sendMessage(ctx.chat.id, tutorialText(chat.title || chat.username || raw));
    return;
  }
});

// Бот сам стал/перестал быть админом в каком-то чате
bot.on("my_chat_member", async (ctx) => {
  const upd = ctx.myChatMember;
  const chatId = upd.chat.id;
  const newStatus = upd.new_chat_member.status;

  if (newStatus === "administrator") {
    let ownerEntry = Object.entries(pendingLinks).find(([, v]) => v.chatId === chatId);
    let ownerId = ownerEntry ? Number(ownerEntry[0]) : upd.from.id;

    protectedChats[chatId] = { ownerId, title: upd.chat.title || String(chatId), antiRaid: false };
    saveProtected();

    if (ownerEntry) {
      delete pendingLinks[ownerEntry[0]];
      savePending();
    }

    let rightsWarning = "";
    if (upd.new_chat_member.can_restrict_members === false) {
      rightsWarning = "\n\n⚠️ Похоже, право «Блокировка пользователей» не выдано — кик работать не будет, пока его не включишь в настройках администратора.";
    }

    try {
      await sendMessage(ownerId, controlPanelText(protectedChats[chatId].title) + rightsWarning, controlKeyboard(chatId, false));
    } catch (e) {
      console.warn(`⚠️ Не удалось написать владельцу ${ownerId}: ${e.message}`);
    }
  } else if (protectedChats[chatId]) {
    delete protectedChats[chatId];
    saveProtected();
  }
});

bot.callbackQuery(/^toggle:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  p.antiRaid = !p.antiRaid;
  saveProtected();
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, controlPanelText(p.title), controlKeyboard(chatId, p.antiRaid));
  await ctx.answerCallbackQuery({ text: p.antiRaid ? "Анти-накрут включён" : "Анти-накрут выключен" });
});

bot.callbackQuery(/^kicklist:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  ctx.session.kickListChatId = chatId;
  await sendMessage(
    ctx.chat.id,
    `Режим кика по списку для «${p.title}» включён.\n\nПришлите ID через пробел и/или пересылайте сюда сообщения нужных людей — каждого выгоню сразу. Выход — /cancel.`
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^chatinfo:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    const count = await bot.api.getChatMemberCount(chatId);
    const admins = await bot.api.getChatAdministrators(chatId);
    const adminLines = admins.map((a) => `— ${userLabel(a.user)}${a.user.id === BOT_ID ? " (это я)" : ""}`);
    await sendMessage(ctx.chat.id, `«${p.title}»\n\nУчастников: ${count}\n\nАдминистраторы:\n${adminLines.join("\n")}`);
  } catch (e) {
    await sendMessage(ctx.chat.id, `Не удалось получить информацию: ${e.message}`);
  }
});

// Живой антинакрут: кто-то реально зашёл в защищённый чат/канал
bot.on("chat_member", async (ctx) => {
  const upd = ctx.chatMember;
  const chatId = upd.chat.id;
  const p = protectedChats[chatId];
  if (!p || !p.antiRaid) return;

  const was = upd.old_chat_member.status;
  const now = upd.new_chat_member.status;
  const joined = (was === "left" || was === "kicked") && (now === "member" || now === "restricted");
  if (!joined) return;

  const u = upd.new_chat_member.user;
  if (u.id === BOT_ID) return;

  try {
    await kickMember(chatId, u.id);
    await sendMessage(chatId, `Пользователь ${userLabel(u)} был выгнан.`);
  } catch (e) {
    console.warn(`⚠️ Не удалось выгнать ${u.id} из ${chatId}: ${e.message}`);
  }
});

bot.catch((err) => {
  console.error("Необработанная ошибка бота:", err);
});

/* ---------- ЗАПУСК: webhook или polling + анти-слип ---------- */

async function keepAliveLoop() {
  const url = `${EXTERNAL_URL}/health`;
  await new Promise((r) => setTimeout(r, 10000));
  while (true) {
    let success = false;
    for (let attempt = 1; attempt <= 3 && !success; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        console.log(`🔄 Keep-alive пинг: ${res.status}`);
        success = true;
      } catch (e) {
        console.warn(`⚠️ Keep-alive пинг не удался (попытка ${attempt}/3): ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!success) console.error("❌ Keep-alive: все попытки пинга провалились в этом цикле");
    await new Promise((r) => setTimeout(r, 150000));
  }
}

function heartbeatLoop() {
  setInterval(() => {
    try {
      const mod = EXTERNAL_URL.startsWith("https") ? https : http;
      const req = mod.get(`${EXTERNAL_URL}/health`, { timeout: 10000 }, (res) => {
        console.log(`💓 Heartbeat пинг: ${res.statusCode}`);
        res.resume();
      });
      req.on("timeout", () => req.destroy());
      req.on("error", (e) => console.warn(`⚠️ Heartbeat пинг не удался: ${e.message}`));
    } catch (e) {
      console.warn(`⚠️ Heartbeat ошибка: ${e.message}`);
    }
  }, 240000);
}

async function startWebhook() {
  const handleUpdate = webhookCallback(bot, "http");
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"ok":false}');
        req.destroy();
        return;
      }
      handleUpdate(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });

  server.listen(PORT, async () => {
    console.log(`✅ Сервер на порту ${PORT}`);
    try {
      await bot.api.setWebhook(`${EXTERNAL_URL}${WEBHOOK_PATH}`, {
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
      });
      console.log("✅ Webhook установлен");
    } catch (e) {
      console.error("❌ Webhook error:", e);
    }
    keepAliveLoop();
    heartbeatLoop();
  });
}

async function setupCommandMenu() {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Подключить защиту чата/канала" },
      { command: "panel", description: "Открыть панель управления" },
      { command: "cancel", description: "Отменить текущее действие" },
    ]);
  } catch (e) {
    console.warn(`⚠️ Не удалось задать меню команд: ${e.message}`);
  }
}

async function main() {
  const me = await bot.api.getMe();
  BOT_ID = me.id;

  await setupCommandMenu();

  if (USE_WEBHOOK) {
    console.log("🚀 Бот запущен в режиме webhook");
    await startWebhook();
  } else {
    console.log("🚀 Бот запущен в режиме long polling");
    await bot.start({ allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"] });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
