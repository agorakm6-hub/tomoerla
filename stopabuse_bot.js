import "dotenv/config";
import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import { Bot, session, webhookCallback } from "grammy";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

/* ---------- CONFIG ---------- */

function env(name, required = true) {
  const val = process.env[name] ?? "";
  if (required && !val) throw new Error(`Переменная окружения ${name} не задана`);
  return val;
}

const BOT_TOKEN = env("BOT_TOKEN");
const API_ID = Number(env("API_ID"));
const API_HASH = env("API_HASH");
// Нужна ТОЛЬКО для массового кика (перечисление участников через MTProto —
// Bot API такого метода не даёт). Анти-накрут на лету работает без неё.
const SESSION_STRING = env("SESSION_STRING");

const MASS_KICK_DELAY_MS = Number(env("MASS_KICK_DELAY_MS", false) || "300"); // пауза между кик-запросами

// Вебхук/анти-слип — по желанию, тот же паттерн, что в прошлых ботах.
const PORT = Number(process.env.PORT || 10000);
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL || "";
const USE_WEBHOOK = Boolean(EXTERNAL_URL);
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");

/* ---------- USERBOT (MTProto, только для перечисления участников) ---------- */

const tgClient = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
  connectionRetries: 5,
});
let tgStarted = false;

async function userbotStart() {
  if (!tgStarted) {
    await tgClient.connect();
    tgStarted = true;
  }
}

async function userbotStop() {
  if (tgStarted) {
    await tgClient.disconnect();
    tgStarted = false;
  }
}

/**
 * Все участники чата/канала через MTProto — Bot API такого списка не отдаёт.
 * Собираем вручную постранично (по 200 — максимум Telegram за один запрос),
 * а не полагаемся на library-хелпер с неочевидной семантикой limit:0.
 * При FLOOD_WAIT от сервера — ждём ровно столько, сколько он просит, и
 * продолжаем с того же места, а не обрываем сбор на середине.
 */
async function getAllParticipants(chatId) {
  await userbotStart();
  const entity = await tgClient.getEntity(chatId);
  const PAGE_SIZE = 200;
  const seen = new Map();
  let offset = 0;

  while (true) {
    let page;
    try {
      page = await tgClient.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: new Api.ChannelParticipantsRecent({}),
          offset,
          limit: PAGE_SIZE,
          hash: 0n,
        })
      );
    } catch (e) {
      const msg = String(e?.errorMessage || e?.message || e);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) {
        const waitSec = Number(flood[1]);
        console.warn(`⚠️ FloodWait при сборе участников: жду ${waitSec} сек`);
        await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
        continue; // повторяем ту же страницу
      }
      throw e;
    }

    const users = page.users || [];
    if (users.length === 0) break;

    for (const u of users) {
      seen.set(Number(u.id), { id: Number(u.id), username: u.username || null, isBot: Boolean(u.bot) });
    }

    if (users.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return Array.from(seen.values());
}

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

/** Кик с ретраем при лимите от Bot API (retry_after в ответе) — не бросает пользователя, а ждёт и повторяет. */
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
    [button("Массовый кик", `mkick:${chatId}`, "danger")],
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
bot.use(session({ initial: () => ({ waitingChatLink: false, massKickChatId: null }) }));

// Временное хранилище подготовленных (но ещё не подтверждённых) массовых киков.
const pendingMassKicks = new Map(); // key: `${ownerId}:${chatId}` -> { keepUsernames, keepIds }

let BOT_ID = null;

bot.command("start", async (ctx) => {
  ctx.session.waitingChatLink = true;
  ctx.session.massKickChatId = null;
  await sendMessage(ctx.chat.id, WELCOME_TEXT);
});

bot.command("cancel", async (ctx) => {
  ctx.session.waitingChatLink = false;
  ctx.session.massKickChatId = null;
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

// Один общий обработчик текста — порядок важен: сначала массовый кик (если
// ждём список), потом привязка чата. Несколько раздельных bot.on("message:text")
// в grammY не сработали бы вместе (вторая не вызовется без next()).
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  if (ctx.session.massKickChatId) {
    const chatId = ctx.session.massKickChatId;
    ctx.session.massKickChatId = null;

    const p = protectedChats[chatId];
    if (!p) {
      await sendMessage(ctx.chat.id, "Этот чат больше не под защитой бота.");
      return;
    }

    const tokens = ctx.message.text.trim().split(/\s+/).filter(Boolean);
    const keepUsernames = new Set(tokens.filter((t) => t.startsWith("@")).map((t) => t.slice(1).toLowerCase()));
    const keepIds = new Set(tokens.filter((t) => /^\d+$/.test(t)).map(Number));

    const key = `${ctx.from.id}:${chatId}`;
    pendingMassKicks.set(key, { keepUsernames, keepIds });

    const keepCount = keepUsernames.size + keepIds.size;
    await sendMessage(
      ctx.chat.id,
      `Будут выгнаны ВСЕ участники «${p.title}», кроме ${keepCount} указанных. Это необратимо. Подтвердить?`,
      keyboard([[button("Да, выгнать", `mkick_confirm:${chatId}`, "danger"), button("Отмена", `mkick_cancel:${chatId}`, "primary")]])
    );
    return;
  }

  if (ctx.session.waitingChatLink) {
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
    // Сначала ищем по предварительно присланной ссылке; если её не было
    // (например, приватный чат) — владелец это тот, кто выдал права прямо сейчас.
    let ownerEntry = Object.entries(pendingLinks).find(([, v]) => v.chatId === chatId);
    let ownerId = ownerEntry ? Number(ownerEntry[0]) : upd.from.id;

    protectedChats[chatId] = { ownerId, title: upd.chat.title || String(chatId), antiRaid: false };
    saveProtected();

    if (ownerEntry) {
      delete pendingLinks[ownerEntry[0]];
      savePending();
    }

    // Права даёт человек, и он мог не поставить галочку "Блокировка
    // пользователей" — без неё кик физически не сработает. Проверяем
    // и честно предупреждаем, а не выясняем это в момент первого кика.
    let rightsWarning = "";
    const canBan = upd.new_chat_member.can_restrict_members;
    if (canBan === false) {
      rightsWarning = "\n\n⚠️ Похоже, право «Блокировка пользователей» не выдано — кик работать не будет, пока его не включишь в настройках администратора.";
    }

    try {
      await sendMessage(ownerId, controlPanelText(protectedChats[chatId].title) + rightsWarning, controlKeyboard(chatId, false));
    } catch (e) {
      console.warn(`⚠️ Не удалось написать владельцу ${ownerId}: ${e.message}`);
    }
  } else if (protectedChats[chatId]) {
    // Бота разжаловали или выгнали — защита больше не действует
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

bot.callbackQuery(/^mkick:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const p = protectedChats[chatId];
  if (!p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }
  ctx.session.massKickChatId = chatId;
  await sendMessage(ctx.chat.id, "Пришлите юзернеймы или ID через пробел — тех, кого нужно ОСТАВИТЬ в чате. Все остальные будут выгнаны.");
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^mkick_cancel:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  pendingMassKicks.delete(`${ctx.from.id}:${chatId}`);
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, "Массовый кик отменён.");
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^mkick_confirm:(-?\d+)$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const key = `${ctx.from.id}:${chatId}`;
  const prepared = pendingMassKicks.get(key);
  const p = protectedChats[chatId];

  if (!prepared || !p || p.ownerId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Запрос устарел или нет доступа" });
    return;
  }
  pendingMassKicks.delete(key);
  await ctx.answerCallbackQuery();
  await editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, "Собираю список участников — на больших чатах это может занять время...");

  let participants;
  try {
    participants = await getAllParticipants(chatId);
  } catch (e) {
    await sendMessage(ctx.chat.id, `Не удалось получить список участников: ${e.message}`);
    return;
  }

  const { keepUsernames, keepIds } = prepared;
  let kicked = 0;
  let processed = 0;

  for (const u of participants) {
    processed++;
    if (u.id === BOT_ID || u.id === p.ownerId) continue;
    const inWhitelist = keepIds.has(u.id) || (u.username && keepUsernames.has(u.username.toLowerCase()));
    if (inWhitelist) continue;

    const ok = await kickMemberWithRetry(chatId, u.id);
    if (ok) kicked++;

    if (processed % 50 === 0) {
      await sendMessage(ctx.chat.id, `Промежуточно: обработано ${processed} из ${participants.length}, выгнано ${kicked}...`);
    }
    await new Promise((r) => setTimeout(r, MASS_KICK_DELAY_MS));
  }

  await sendMessage(ctx.chat.id, `Были выгнаны ${kicked} пользователей.`);
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

main().catch(async (err) => {
  console.error(err);
  await userbotStop();
  process.exit(1);
});
