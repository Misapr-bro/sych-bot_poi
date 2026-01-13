const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const parser = require('../services/parser');
const videoVision = require('../services/video_vision');

// ============================================================
// БЛОК 1: ГЛОБАЛЬНЫЕ СОСТОЯНИЯ И КОНСТАНТЫ
// ============================================================

const chatHistory = {};       
const analysisBuffers = {};   
const BUFFER_SIZE = 20;       
const DEBUG = true; 

function log(tag, message) {
    if (DEBUG) {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`[${timestamp}][${tag}] ${message}`);
    }
}

// [ВОССТАНОВЛЕНО] Функция истории (исправляет краш addToHistory is not defined)
function addToHistory(chatId, role, text) {
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role, text });
    if (chatHistory[chatId].length > 20) chatHistory[chatId].shift();
}

function getAnnaErrorReply(errText) {
    const error = errText.toLowerCase();
    if (error.includes('prohibited') || error.includes('safety')) return "🛑 Ошибка безопасности AI.";
    if (error.includes('503') || error.includes('overloaded')) return "💤 Сервера перегружены.";
    return "🛠 Технический сбой.";
}

function getReplyOptions(msg) {
    return { 
        reply_to_message_id: msg.message_id, 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true 
    };
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
// БЛОК 3: ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================================

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let text = msg.text || msg.caption || "";
    const foundUrl = extractUrl(msg); 
    
    log("PROCESS", `Chat: ${chatId} | Msg: ${text.substring(0, 30)}...`);

    // МЕНЮ ВЫБОРА МОДЕЛИ
    if (text === "/model" || text === "⚙️ Модель") {
        const modelKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⚡ Gemini 2.5 Flash Lite", callback_data: "set_model:google/gemini-2.5-flash-lite" }],
                    [{ text: "💎 Gemini 2.5 Flash", callback_data: "set_model:google/gemini-2.5-flash" }],
                    [{ text: "🧠 Gemini 2.0 Pro Exp", callback_data: "set_model:google/gemini-2.0-pro-exp-02-05:free" }]
                ]
            }
        };
        await bot.sendMessage(chatId, `🔧 **Мозг Анны**\nТекущая модель: \`${ai.modelName}\``, getReplyOptions(msg));
        await bot.sendMessage(chatId, "Выбери:", modelKeyboard);
        return; 
    }

    let typingTimer = null;
    const stopTyping = () => { if (typingTimer) { clearInterval(typingTimer); typingTimer = null; } };
    const startTyping = () => {
        if (typingTimer) return;
        const action = () => { bot.sendChatAction(chatId, 'typing').catch(() => {}); };
        action();
        typingTimer = setInterval(action, 4000);
    };

    try {
        // --- 3.0. [НОВОЕ] РУЧНОЕ СОХРАНЕНИЕ (РЕПЛАЙ "В МД") ---
        if (msg.reply_to_message && (text.toLowerCase().includes('в мд') || text === '/save')) {
            const originalMsg = msg.reply_to_message;
            const targetUrl = extractUrl(originalMsg);
            
            startTyping();
            
            // Сценарий А: Видео
            if (targetUrl && (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be'))) {
                 const result = await videoVision.processVideo(targetUrl);
                 const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                 stopTyping();
                 await bot.sendMessage(chatId, `✅ **Видео сохранено вручную**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                 return;
            }

            // Сценарий Б: Статья
            if (targetUrl) {
                const title = await parser.saveArticle(targetUrl);
                stopTyping();
                await bot.sendMessage(chatId, `✅ **Статья сохранена вручную**\n📄 ${title}`, getReplyOptions(msg));
                return;
            }

            // Сценарий В: Текст
            const content = originalMsg.text || originalMsg.caption || "";
            if (content) {
                const safeTitle = content.substring(0, 40).replace(/[^\w\sа-яё]/gi, '') + "...";
                const savedTitle = parser.saveDirectContent(`Заметка: ${safeTitle}`, content);
                stopTyping();
                await bot.sendMessage(chatId, `✅ **Текст сохранен**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                return;
            }
        }

        // --- 3.3. БОТ-ФИЛЬТР: ГОЛОСОВЫЕ ---
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

        // --- 3.4. БОТ-ФИЛЬТР: YOUTUBE (AVTO) ---
        if (foundUrl && (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be'))) {
            log("YOUTUBE", "Запуск Vision анализа...");
            startTyping();
            try {
                const result = await videoVision.processVideo(foundUrl);
                const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                stopTyping();
                await bot.sendMessage(chatId, `✅ **Конспект готов!**\n📄 Файл: \`${savedTitle.replace(/`/g, '')}\``, getReplyOptions(msg));
                return;
            } catch (e) {
                stopTyping();
                await bot.sendMessage(chatId, "❌ Ошибка видео: " + e.message);
                return;
            }
        }

        // --- 3.5. БОТ-ФИЛЬТР: СТАТЬИ (AVTO) ---
        if (foundUrl && text.length < 500) {
            startTyping();
            const title = await parser.saveArticle(foundUrl);
            stopTyping();
            await bot.sendMessage(chatId, "✍️ Заметка сохранена: " + title, getReplyOptions(msg));
            return;
        }

        // --- 3.6. МЕДИА (ФОТО) ---
        let imageBuffer = null;
        if (msg.photo || (msg.sticker && !msg.sticker.is_animated)) {
            const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.sticker.file_id;
            const link = await bot.getFileLink(fileId);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
        }

        // --- 3.7. ЯДРО AI ---
        if (text || imageBuffer) {
            startTyping();
            
            const instruction = storage.getUserInstruction(msg.from.username || "");
            const userProfile = storage.getProfile(chatId, userId);
            const history = chatHistory[chatId] || [];

            const aiResponse = await ai.getResponse(history, { text }, imageBuffer, "image/jpeg", instruction, userProfile);
            
            const chunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
            }

            stopTyping();
            
            addToHistory(chatId, msg.from.first_name, text);
            addToHistory(chatId, "Анна", aiResponse);
        }

    } catch (fatalError) {
        log("FATAL", fatalError.message);
        stopTyping();
        // Уведомляем пользователя только если это был явный запрос
        if (text.includes('/save') || text.includes('в мд')) {
            await bot.sendMessage(chatId, "❌ Сбой сохранения: " + fatalError.message, getReplyOptions(msg));
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
            await bot.sendMessage(query.message.chat.id, `✅ Ядро обновлено: \`${newModel}\``);
        }
    });
}

module.exports = { processMessage, setupCallback };