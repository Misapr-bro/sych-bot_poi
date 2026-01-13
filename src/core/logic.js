const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
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

function addToHistory(chatId, role, text) {
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    chatHistory[chatId].push({ role, text });
    const limit = config.contextSize || 30;
    if (chatHistory[chatId].length > limit) chatHistory[chatId].shift();
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
// БЛОК 3: ОСНОВНОЙ ОБРАБОТЧИК (ПРИОРИТЕТЫ)
// ============================================================

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let text = msg.text || msg.caption || "";
    const foundUrl = extractUrl(msg); 
    
    log("PROCESS", `Chat: ${chatId} | Msg: ${text.substring(0, 30)}...`);

    // 0. МЕНЮ ВЫБОРА МОДЕЛИ
    if (text === "/model" || text === "⚙️ Выбор модели AI") {
        const modelKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⚡ Gemini 2.5 Lite (Чат/Эконом)", callback_data: "set_model:google/gemini-2.5-flash-lite-preview-02-05:free" }],
                    [{ text: "💎 Gemini 2.5 Flash (Видео/Баланс)", callback_data: "set_model:google/gemini-2.5-flash-001" }],
                    [{ text: "🧠 Gemini 2.0 Pro Exp (Мозг/Психолог)", callback_data: "set_model:google/gemini-2.0-pro-exp-02-05:free" }]
                ]
            }
        };
        await bot.sendMessage(chatId, `🔧 **Ядро Анны**\nТекущая модель: \`${ai.modelName}\``, getReplyOptions(msg));
        await bot.sendMessage(chatId, "Список ядер:", modelKeyboard);
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
        // ============================================================
        // ПРИОРИТЕТ №1: РУЧНОЕ СОХРАНЕНИЕ ЧЕРЕЗ РЕПЛАЙ ("В МД")
        // ============================================================
        // Если ты отвечаешь на сообщение командой "save", "в мд", "md"
        if (msg.reply_to_message) {
            const triggerWords = ['в мд', 'save', 'сохрани', 'md', '/save'];
            const isSaveCommand = triggerWords.some(w => text.toLowerCase().includes(w));

            if (isSaveCommand) {
                log("MANUAL", "Принудительное сохранение через реплай...");
                startTyping();
                
                const originalMsg = msg.reply_to_message;
                const targetUrl = extractUrl(originalMsg);
                const originalText = originalMsg.text || originalMsg.caption || "";

                // А: В реплае была ссылка (Видео или Статья)
                if (targetUrl) {
                    if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
                        const result = await videoVision.processVideo(targetUrl);
                        const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                        stopTyping();
                        await bot.sendMessage(chatId, `✅ **Видео сохранено**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                        return;
                    } else {
                        const title = await parser.saveArticle(targetUrl);
                        stopTyping();
                        await bot.sendMessage(chatId, `✅ **Статья сохранена**\n📄 ${title}`, getReplyOptions(msg));
                        return;
                    }
                }

                // Б: В реплае был просто текст (или репост без ссылки)
                if (originalText) {
                    // Генерируем имя файла
                    const safeTitle = originalText.substring(0, 40).replace(/[^\w\sа-яё]/gi, '') + "...";
                    
                    // Формируем контент как заметку
                    const fileContent = `---
date: ${new Date().toISOString().split('T')[0]}
type: manual_note
tags: [inbox, manual]
---

${originalText}`;

                    const savedTitle = parser.saveDirectContent(`Note_${Date.now()}`, fileContent);
                    stopTyping();
                    await bot.sendMessage(chatId, `✅ **Текст сохранен**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                    return;
                }
            }
        }

        // ============================================================
        // ПРИОРИТЕТ №2: АВТО-СОХРАНЕНИЕ РЕПОСТОВ (FORWARDS)
        // ============================================================
        // Ловит явные пересылки (если Telegram не стер заголовки)
        if (msg.forward_date || msg.forward_from || msg.forward_from_chat) {
            log("FORWARD", "Обнаружен репост. Сохраняю...");
            startTyping();
            
            const senderName = msg.forward_from_chat ? msg.forward_from_chat.title : (msg.forward_from ? msg.forward_from.first_name : "Unknown");
            const senderUsername = msg.forward_from_chat ? msg.forward_from_chat.username : (msg.forward_from ? msg.forward_from.username : null);
            
            // Если в репосте есть ссылка на YouTube -> Vision
            if (foundUrl && (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be'))) {
                 const result = await videoVision.processVideo(foundUrl);
                 const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                 stopTyping();
                 await bot.sendMessage(chatId, `💾 **Репост (Видео) сохранен**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                 return;
            }

            // Иначе сохраняем как текст/статью
            const savedTitle = await parser.saveForwardedMessage(text, senderName, senderUsername, msg.chat.title, msg.message_id, chatId); // Исправлено: вызываем функцию сохранения
            // Если saveForwardedMessage нет, используем saveDirectContent:
            // const savedTitle = parser.saveDirectContent(`Repost_${senderName}`, text);
            
            stopTyping();
            await bot.sendMessage(chatId, `💾 **Репост сохранен**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
            return;
        }

        // ============================================================
        // ПРИОРИТЕТ №3: АВТО-ПАРСИНГ ССЫЛОК (КЛИППЕР)
        // ============================================================
        // Если сообщение это ТОЛЬКО ссылка (без длинного комментария)
        if (foundUrl && text.length < 200) {
            
            // YouTube
            if (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be')) {
                log("YOUTUBE", "Vision анализ...");
                startTyping();
                const result = await videoVision.processVideo(foundUrl);
                const savedTitle = parser.saveDirectContent(result.title, result.analysis);
                stopTyping();
                await bot.sendMessage(chatId, `✅ **Конспект видео**\n📄 \`${savedTitle}\``, getReplyOptions(msg));
                return;
            }

            // Статья
            startTyping();
            const title = await parser.saveArticle(foundUrl);
            stopTyping();
            await bot.sendMessage(chatId, "✍️ **Статья сохранена:** " + title, getReplyOptions(msg));
            return;
        }

        // ============================================================
        // ПРИОРИТЕТ №4: ЯДРО AI (ЧАТ)
        // ============================================================
        // Сюда попадаем, только если это не реплай "в мд", не репост и не просто ссылка
        
        // Бот-фильтр: Голосовые
        if (msg.voice || msg.audio) {
            startTyping();
            const media = msg.voice || msg.audio;
            const link = await bot.getFileLink(media.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            const transcription = await ai.transcribeAudio(Buffer.from(resp.data), msg.from.first_name);
            if (transcription && transcription.text) {
                text = transcription.text;
                await bot.sendMessage(chatId, "🎤 Расшифровка:\n" + text);
                // Продолжаем выполнение, чтобы AI ответил на расшифровку
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
                await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
            }

            stopTyping();
            addToHistory(chatId, msg.from.first_name, text);
            addToHistory(chatId, "Анна", aiResponse);
        }

    } catch (fatalError) {
        log("FATAL", fatalError.message);
        stopTyping();
        if (text.includes('/save') || text.includes('в мд')) {
            await bot.sendMessage(chatId, "❌ Ошибка сохранения: " + fatalError.message, getReplyOptions(msg));
        }
    }
}

// Экспорт (не забудь!)
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