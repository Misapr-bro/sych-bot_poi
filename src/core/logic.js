const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const parser = require('../services/parser');
const videoVision = require('../services/video_vision');

// ============================================================
// БЛОК 1: ГЛОБАЛЬНЫЕ СОСТОЯНИЯ
// ============================================================

const chatHistory = {};
const DEBUG = true;

function log(tag, message) {
    if (DEBUG) {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`[${timestamp}][${tag}] ${message}`);
    }
}

// [ВОССТАНОВЛЕНО] Функция истории (без нее бот падает)
function addToHistory(chatId, role, text) {
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role, text });
    const limit = config.contextSize || 30;
    if (chatHistory[chatId].length > limit) chatHistory[chatId].shift();
}

// 1. Опции для СИСТЕМНЫХ сообщений (HTML, надежно)
function getHtmlReplyOptions(msg) {
    return {
        reply_to_message_id: msg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
}

// 2. Опции для AI ответов (Markdown, чтобы работало форматирование нейросети)
function getMarkdownReplyOptions(msg) {
    return {
        reply_to_message_id: msg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    };
}

// Экранирование спецсимволов для HTML (более надежно чем Markdown)
function escapeHTML(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function extractUrl(message) {
    const entities = message.entities || message.caption_entities || [];
    for (const entity of entities) {
        if (entity.type === 'text_link') return entity.url;
        if (entity.type === 'url') {
            const raw = message.text || message.caption || "";
            return raw.substring(entity.offset, entity.offset + entity.length);
        }
    }
    const match = (message.text || message.caption || "").match(/(https?:\/\/[^\s]+)/);
    return match ? match[0] : null;
}

// ============================================================
// БЛОК 3: ОСНОВНОЙ ОБРАБОТЧИК (С ПРИОРИТЕТАМИ)
// ============================================================

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let text = msg.text || msg.caption || "";
    const foundUrl = extractUrl(msg);

    log("PROCESS", `Chat: ${chatId} | Msg: ${text.substring(0, 30)}...`);

    // 0. МЕНЮ ВЫБОРА МОДЕЛИ
    if (text === "/model" || text === "⚙️ Выбор модели AI" || text === "⚙️ Модель") {
        const modelKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⚡ Gemini 2.5 Lite (Чат/Эконом)", callback_data: "set_model:google/gemini-2.5-flash-lite" }],
                    [{ text: "💎 Gemini 2.5 Flash (Видео/Баланс)", callback_data: "set_model:google/gemini-2.5-flash" }],
                    [{ text: "🧠 Gemini 2.0 Pro Exp (Мозг/Психолог)", callback_data: "set_model:google/gemini-2.0-pro-exp-02-05:free" }]
                ]
            }
        };
        await bot.sendMessage(chatId, `🔧 <b>Ядро Анны</b>\nТекущая модель: <code>${ai.modelName}</code>`, getHtmlReplyOptions(msg));
        await bot.sendMessage(chatId, "Список ядер:", modelKeyboard);
        return;
    }

    let typingTimer = null;
    const stopTyping = () => { if (typingTimer) { clearInterval(typingTimer); typingTimer = null; } };
    const startTyping = () => {
        if (typingTimer) return;
        const action = () => { bot.sendChatAction(chatId, 'typing').catch(() => { }); };
        action();
        typingTimer = setInterval(action, 4000);
    };

    try {
        // ============================================================
        // [ПРИОРИТЕТ 1] РУЧНОЕ СОХРАНЕНИЕ ЧЕРЕЗ РЕПЛАЙ ("В МД")
        // ============================================================
        if (msg.reply_to_message) {
            const triggerWords = ['мд', 'в мд', 'save', 'сохрани', 'md', '/save'];
            const isSaveCommand = triggerWords.some(w => text.toLowerCase().trim() === w || text.toLowerCase().includes(w));

            if (isSaveCommand) {
                log("MANUAL", "Принудительное сохранение через реплай...");
                startTyping();

                const originalMsg = msg.reply_to_message;
                const targetUrl = extractUrl(originalMsg);
                const originalText = originalMsg.text || originalMsg.caption || "";

                // А: Ссылка (Видео/Статья)
                if (targetUrl) {
                    if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
                        const result = await videoVision.processVideo(targetUrl);
                        const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                        stopTyping();
                        await bot.sendMessage(chatId, `✅ <b>Видео сохранено</b>\n📄 <code>${escapeHTML(savedTitle)}</code>`, getHtmlReplyOptions(msg));
                        return;
                    } else {
                        const title = await parser.saveArticle(targetUrl);
                        stopTyping();
                        await bot.sendMessage(chatId, `✅ <b>Статья сохранена</b>\n📄 ${escapeHTML(title)}`, getHtmlReplyOptions(msg));
                        return;
                    }
                }

                // Б: Текст
                if (originalText) {
                    const safeTitle = originalText.substring(0, 40).replace(/[^\w\sа-яё]/gi, '') + "...";
                    const fileContent = `---
date: ${new Date().toISOString().split('T')[0]}
type: manual_note
tags: [inbox, manual]
---

${originalText}`;

                    const savedTitle = parser.saveDirectContent(`Note_${Date.now()}`, fileContent);
                    stopTyping();
                    await bot.sendMessage(chatId, `✅ <b>Текст сохранен</b>\n📄 <code>${escapeHTML(savedTitle)}</code>`, getHtmlReplyOptions(msg));
                    return;
                }
            }
        }

        // ============================================================
        // [ПРИОРИТЕТ 2] АВТО-СОХРАНЕНИЕ РЕПОСТОВ (FORWARDS)
        // ============================================================
        if (msg.forward_date || msg.forward_from || msg.forward_from_chat) {
            log("FORWARD", "Обнаружен репост. Сохраняю...");
            startTyping();

            const senderName = msg.forward_from_chat ? msg.forward_from_chat.title : (msg.forward_from ? msg.forward_from.first_name : "Unknown");
            const senderUsername = msg.forward_from_chat ? msg.forward_from_chat.username : (msg.forward_from ? msg.forward_from.username : null);

            // Если репост с YouTube -> Vision
            if (foundUrl && (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be'))) {
                const result = await videoVision.processVideo(foundUrl);
                const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                stopTyping();
                await bot.sendMessage(chatId, `💾 <b>Репост (Видео) сохранен</b>\n📄 <code>${escapeHTML(savedTitle)}</code>`, getHtmlReplyOptions(msg));
                return;
            }

            // Иначе сохраняем как текст
            const savedTitle = parser.saveForwardedMessage(text, senderName, senderUsername, msg.chat.title, msg.message_id, chatId);

            stopTyping();
            await bot.sendMessage(chatId, `💾 <b>Репост сохранен</b>\n📄 <code>${escapeHTML(savedTitle)}</code>`, getHtmlReplyOptions(msg));
            return;
        }

        // ============================================================
        // [ПРИОРИТЕТ 3] КЛИППЕР (ЕСЛИ ТОЛЬКО ССЫЛКА)
        // ============================================================
        if (foundUrl && text.length < 200) {
            if (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be')) {
                log("YOUTUBE", "Vision анализ...");
                startTyping();
                const result = await videoVision.processVideo(foundUrl);
                const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                stopTyping();
                await bot.sendMessage(chatId, `✅ <b>Конспект видео</b>\n📄 <code>${escapeHTML(savedTitle)}</code>`, getHtmlReplyOptions(msg));
                return;
            }

            startTyping();
            const title = await parser.saveArticle(foundUrl);
            stopTyping();
            await bot.sendMessage(chatId, "✍️ <b>Статья сохранена:</b> " + escapeHTML(title), getHtmlReplyOptions(msg));
            return;
        }

        // ============================================================
        // [ПРИОРИТЕТ 4] ЯДРО AI (ЧАТ)
        // ============================================================

        // Обработка голосовых
        if (msg.voice || msg.audio) {
            startTyping();
            const media = msg.voice || msg.audio;
            const link = await bot.getFileLink(media.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            const transcription = await ai.transcribeAudio(Buffer.from(resp.data), msg.from.first_name);
            if (transcription && transcription.text) {
                text = transcription.text;
                await bot.sendMessage(chatId, "🎤 Расшифровка:\n" + text);
            }
        }

        if (text || msg.photo) {
            startTyping();

            const instruction = storage.getUserInstruction(msg.from.username || "");
            const userProfile = storage.getProfile(chatId, userId);
            const history = chatHistory[chatId] || [];

            let imageBuffer = null;
            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const link = await bot.getFileLink(fileId);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
            }

            const aiResponse = await ai.getResponse(history, { text }, imageBuffer, "image/jpeg", instruction, userProfile);

            const chunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
            for (const chunk of chunks) {
                // Для AI используем Markdown, чтобы работали жирный шрифт и код
                await bot.sendMessage(chatId, chunk, getMarkdownReplyOptions(msg));
            }

            stopTyping();
            addToHistory(chatId, msg.from.first_name, text);
            addToHistory(chatId, "Анна", aiResponse);
        }

    } catch (fatalError) {
        log("FATAL", fatalError.message);
        stopTyping();
        if (text.includes('/save') || text.includes('в мд')) {
            // Ошибки оборачиваем в HTML, чтобы спецсимволы в тексте ошибки не ломали отправку
            await bot.sendMessage(chatId, "❌ <b>Ошибка сохранения:</b> " + escapeHTML(fatalError.message), getHtmlReplyOptions(msg));
        }
    }
}

function setupCallback(bot) {
    bot.on('callback_query', async (query) => {
        const data = query.data;
        if (data && data.startsWith("set_model:")) {
            const newModel = data.split(":")[1];
            ai.modelName = newModel;
            await bot.answerCallbackQuery(query.id, { text: "Модель изменена" });
            await bot.sendMessage(query.message.chat.id, `✅ Ядро обновлено: <code>${newModel}</code>`, getHtmlReplyOptions(query.message));
        }
    });
}

module.exports = { processMessage, setupCallback };