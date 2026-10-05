import "dotenv/config";
import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import { Bot, session, webhookCallback } from "grammy";

/* ---------- CONFIG ---------- */
// Версия БЕЗ юзербот-сессии — только Bot API.

function env(name, required = true) {
  const val = process.env[name] ?? "";
  if (required && !val) throw new Error(`Переменная окружения ${name} не задана`);
  return val;
}

const BOT_TOKEN = env("BOT_TOKEN");

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

function retryAfterFrom(err) {
  const m = String(err.message).match(/"retry_after":(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Постоянная блокировка — не может зайти заново. */
async function banMemberWithRetry(chatId, userId, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await banChatMember(chatId, userId);
      return true;
    } catch (e) {
      const wait = retryAfterFrom(e);
      if (wait && attempt < maxRetries) {
        console.warn(`⚠️ Лимит Bot API: жду ${wait} сек перед повтором (user ${userId})`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
        continue;
      }
      console.warn(`⚠️ Не удалось заблокировать ${userId} в ${chatId}: ${e.message}`);
      return false;
    }
  }
  return false;
}

/** Временный кик (бан + мгновенный разбан) — человек может зайти заново. */
async function kickMemberWithRetry(chatId, userId, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await banChatMember(chatId, userId);
      await unbanChatMember(chatId, userId);
      return true;
    } catch (e) {
      const wait = retryAfterFrom(e);
      if (wait && attempt < maxRetries) {
        console.warn(`⚠️ Лимит Bot API: жду ${wait} сек перед повтором (user ${userId})`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
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

/* ---------- ХРАНЕНИЕ (JSON-файл рядом с ботом) ---------- */

const PROTECTED_FILE = process.env.PROTECTED_FILE || "protected_chats.json";

let protectedChats = {}; // chatId -> { ownerId, title, antiRaid, antiSpam }
try {
  protectedChats = JSON.parse(fs.readFileSync(PROTECTED_FILE, "utf8"));
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

/** Реальный создатель чата (не просто админ) — через Telegram, а не через то, кто выдал боту права. */
async function getChatCreatorId(chatId, fallbackId) {
  try {
    const admins = await bot.api.getChatAdministrators(chatId);
    const creator = admins.find((a) => a.status === "creator");
    if (creator) return creator.user.id;
  } catch (e) {
    console.warn(`⚠️ Не удалось определить владельца чата ${chatId}: ${e.message}`);
  }
  return fallbackId;
}

/* ---------- ТЕКСТЫ И КЛАВИАТУРЫ ---------- */

const WELCOME_TEXT =
  "Добро пожаловать в Stop Abuse 🛡️\n\n" +
  "Пришлите ссылку на свой чат или канал — разберёмся, как защитить его от накрутки.\n\n" +
  "Отдельно, прямо в самом чате, доступны команды для владельца: ответьте на сообщение нарушителя /kick (временно) или /ban (навсегда), либо укажите @юзернейм или ID без ответа.";

function tutorialText(title) {
  return (
    `«${title}» найден.\n\n` +
    "Чтобы включить защиту, добавьте бота туда администратором с правами:\n" +
    "— Блокировка пользователей\n" +
    "— Удаление сообщений\n" +
    "— Добавление участников\n\n" +
    "Как только права будут выданы, панель управления придёт в личные сообщения владельцу чата."
  );
}

function tutorialTextPrivateFallback(input) {
  return (
    `Не нашёл «${input}» напрямую — скорее всего, это приватный чат без публичного юзернейма.\n\n` +
    "Ничего страшного: просто добавьте бота туда администратором с правами (блокировка пользователей, удаление сообщений, добавление участников) — " +
    "панель управления придёт владельцу в личные сообщения сама, как только права будут выданы."
  );
}

function controlKeyboard(chatId, antiRaidOn, antiSpamOn) {
  return keyboard([
    [
      button(antiRaidOn ? "🛡️ Анти-накрут: вкл" : "Анти-накрут: выкл", `toggle:${chatId}`, antiRaidOn ? "success" : undefined),
      button(antiSpamOn ? "🧹 Анти-спам: вкл" : "Анти-спам: выкл", `togglespam:${chatId}`, antiSpamOn ? "success" : undefined),
    ],
    [button("Информация о чате", `chatinfo:${chatId}`)],
  ]);
}

function controlPanelText(title) {
  return `«${title}» — панель управления`;
}

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
bot.use(session({ initial: () => ({ waitingChatLink: false }) }));

let BOT_ID = null;

// Панель и регистрация — СТРОГО в личных сообщениях. В группе эти команды
// молчат, чтобы участники их вообще не видели (именно это и было проблемой).
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  ctx.session.waitingChatLink = true;
  await sendMessage(ctx.chat.id, WELCOME_TEXT);
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  ctx.session.waitingChatLink = false;
  await sendMessage(ctx.chat.id, "Отменено.");
});

bot.command("panel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const mine = Object.entries(protectedChats).filter(([, p]) => p.ownerId === ctx.from.id);
  if (mine.length === 0) {
    await sendMessage(ctx.chat.id, "У вас пока нет защищённых чатов. Пришлите /start, чтобы подключить первый.");
    return;
  }
  if (mine.length === 1) {
    const [chatId, p] = mine[0];
    await sendMessage(ctx.chat.id, controlPanelText(p.title), controlKeyboard(Number(chatId), p.antiRaid, p.antiSpam));
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
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, controlPanelText(p.title), controlKeyboard(chatId, p.antiRaid, p.antiSpam));
  await ctx.answerCallbackQuery();
});

// Привязка ссылки на чат (только в личке) — одно сообщение handler для не-команд.
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") {
    const p = protectedChats[ctx.chat.id];
    if (p && p.antiSpam && ctx.from && ctx.from.id !== BOT_ID) {
      try {
        await bot.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (e) {
        console.warn(`⚠️ Не удалось удалить сообщение в ${ctx.chat.id}: ${e.message}`);
      }
    }
    return;
  }

  if (ctx.message.text && ctx.message.text.startsWith("/")) return;

  if (ctx.session.waitingChatLink && ctx.message.text) {
    ctx.session.waitingChatLink = false;
    const raw = ctx.message.text.trim();
    const identifier = extractChatIdentifier(raw);

    let chat;
    try {
      chat = await bot.api.getChat(identifier);
    } catch {
      await sendMessage(ctx.chat.id, tutorialTextPrivateFallback(raw));
      return;
    }

    await sendMessage(ctx.chat.id, tutorialText(chat.title || chat.username || raw));
    return;
  }
});

// Бот сам стал/перестал быть админом в чате — панель всегда уходит
// реальному владельцу (создателю), а не тому, кто нажал "назначить".
bot.on("my_chat_member", async (ctx) => {
  const upd = ctx.myChatMember;
  const chatId = upd.chat.id;
  const newStatus = upd.new_chat_member.status;

  if (newStatus === "administrator") {
    const ownerId = await getChatCreatorId(chatId, upd.from.id);

    protectedChats[chatId] = { ownerId, title: upd.chat.title || String(chatId), antiRaid: false, antiSpam: false };
    saveProtected();

    const missing = [];
    if (upd.new_chat_member.can_restrict_members === false) missing.push("«Блокировка пользователей» (анти-накрут, /kick, /ban)");
    if (upd.new_chat_member.can_delete_messages === false) missing.push("«Удаление сообщений» (анти-спам)");
    const rightsWarning = missing.length > 0 ? `\n\n⚠️ Не хватает прав: ${missing.join(", ")}.` : "";

    try {
      await sendMessage(ownerId, controlPanelText(protectedChats[chatId].title) + rightsWarning, controlKeyboard(chatId, false, false));
    } catch {
      // Владелец ни разу не писал боту — Bot API не даёт написать первым.
      try {
        await sendMessage(chatId, "Владелец чата: напишите мне в личные сообщения /start, чтобы получить панель управления.");
      } catch (e2) {
        console.warn(`⚠️ Не удалось уведомить ни владельца, ни чат ${chatId}: ${e2.message}`);
      }
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
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, controlPanelText(p.title), controlKeyboard(chatId, p.antiRaid, p.antiSpam));
  await ctx.answerCallbackQuery({ text: p.antiRaid ? "Анти-накрут включён" : "Анти-накрут выключен" });
});

bot.callbackQuery(/^togglespam:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  p.antiSpam = !p.antiSpam;
  saveProtected();
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, controlPanelText(p.title), controlKeyboard(chatId, p.antiRaid, p.antiSpam));
  await ctx.answerCallbackQuery({ text: p.antiSpam ? "Анти-спам включён — удаляю все сообщения" : "Анти-спам выключен" });
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
    const adminLines = admins.map((a) => `— ${userLabel(a.user)}${a.status === "creator" ? " (владелец)" : ""}`);
    await sendMessage(ctx.chat.id, `«${p.title}»\n\nУчастников: ${count}\n\nАдминистраторы:\n${adminLines.join("\n")}`);
  } catch (e) {
    await sendMessage(ctx.chat.id, `Не удалось получить информацию: ${e.message}`);
  }
});

// Живой антинакрут: кто-то реально зашёл в защищённый чат/канал.
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

  const ok = await banMemberWithRetry(chatId, u.id);
  if (ok) {
    try {
      await sendMessage(chatId, `Пользователь ${userLabel(u)} был заблокирован.`);
    } catch (e) {
      console.warn(`⚠️ Не удалось отправить уведомление в ${chatId}: ${e.message}`);
    }
  }
});

/* ---------- /kick и /ban прямо в чате — только для реального владельца ---------- */

async function resolveTarget(ctx) {
  if (ctx.message.reply_to_message?.from) {
    return ctx.message.reply_to_message.from;
  }
  const arg = (ctx.match || "").trim();
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return { id: Number(arg) };
  try {
    const chat = await bot.api.getChat(`@${arg.replace(/^@/, "")}`);
    return { id: chat.id, username: chat.username, first_name: chat.first_name, last_name: chat.last_name };
  } catch {
    return null;
  }
}

async function handleModerationCommand(ctx, mode) {
  let member;
  try {
    member = await bot.api.getChatMember(ctx.chat.id, ctx.from.id);
  } catch {
    return;
  }
  if (member.status !== "creator") return; // не владелец — тихо игнорируем

  const target = await resolveTarget(ctx);
  if (!target) {
    await sendMessage(
      ctx.chat.id,
      `Ответьте этой командой на сообщение нарушителя, либо напишите /${mode} @юзернейм или /${mode} id.`
    );
    return;
  }

  const ok = mode === "ban" ? await banMemberWithRetry(ctx.chat.id, target.id) : await kickMemberWithRetry(ctx.chat.id, target.id);
  if (!ok) {
    await sendMessage(ctx.chat.id, "Не получилось выполнить действие — проверь, что у бота есть право «Блокировка пользователей».");
    return;
  }

  const label = target.username || target.first_name ? userLabel(target) : String(target.id);
  await sendMessage(ctx.chat.id, `Пользователь ${label} ${mode === "ban" ? "забанен" : "выгнан"}.`);
}

bot.command("kick", async (ctx) => {
  if (ctx.chat.type === "private") return;
  await handleModerationCommand(ctx, "kick");
});

bot.command("ban", async (ctx) => {
  if (ctx.chat.type === "private") return;
  await handleModerationCommand(ctx, "ban");
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
    // Отдельное меню для групп — там показываем именно /kick и /ban.
    await bot.api.setMyCommands(
      [
        { command: "kick", description: "Выгнать (ответом на сообщение или @юзернейм/id)" },
        { command: "ban", description: "Забанить (ответом на сообщение или @юзернейм/id)" },
      ],
      { scope: { type: "all_group_chats" } }
    );
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
