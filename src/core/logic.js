const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const axios = require('axios');
const { exec } = require('child_process');
const parser = require('../services/parser');
const youtube = require('../services/youtube');

const chatHistory = {}; 
const analysisBuffers = {}; 
const BUFFER_SIZE = 20; 

// === НАСТРОЙКА ОТЛАДКИ (LOGGING) ===
const DEBUG = true; 

function log(tag, message) {
    if (DEBUG) {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        console.log('[' + timestamp + '][' + tag + '] ' + message);
    }
}

// === ГЕНЕРАТОР ТЕХНИЧЕСКИХ ОТВЕТОВ ===
function getAnnaErrorReply(errText) {
    const error = errText.toLowerCase();

    // 1. ЦЕНЗУРА
    if (error.includes('prohibited') || error.includes('safety') || error.includes('blocked') || error.includes('policy')) {
        const phrases = [
            "🛑 Фильтры безопасности Google заблокировали этот ответ. Давай попробуем переформулировать тему мягче?",
            "🤐 Я бы хотела ответить, но это нарушает правила безопасности AI. Прости, я не могу это обсудить.",
            "⚠️ Тема слишком чувствительная для алгоритмов. Они заблокировали генерацию."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 2. ПЕРЕГРУЗКА
    if (error.includes('503') || error.includes('overloaded') || error.includes('unavailable') || error.includes('timeout')) {
        const phrases = [
            "💤 Сервера сейчас перегружены. Дай мне минутку выдохнуть, и я отвечу.",
            "⏳ Большая нагрузка на сеть. Подожди немного, пожалуйста.",
            "🐌 Нейросеть отвечает медленнее обычного. Нужно чуть-чуть подождать."
        ];
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    // 3. ЛИМИТЫ
    if (error.includes('429') || error.includes('quota') || error.includes('exhausted') || error.includes('лимит')) {
        return "⏳ Мы общаемся слишком быстро, лимиты исчерпаны. Давай сделаем небольшую паузу.";
    }

    // 4. ТЯЖЕЛЫЙ ЗАПРОС
    if (error.includes('400') || error.includes('too large') || error.includes('invalid argument')) {
        return "🐘 Сообщение или файл слишком большие для обработки. Попробуй сократить или разбить на части.";
    }

    // 5. ДЕФОЛТНАЯ ОШИБКА
    return "🛠 Возникла техническая ошибка. Попробуй спросить еще раз.";
}

function addToHistory(chatId, sender, text) {
  if (!chatHistory[chatId]) {
      chatHistory[chatId] = [];
  }
  chatHistory[chatId].push({ role: sender, text: text });
  if (chatHistory[chatId].length > config.contextSize) {
    chatHistory[chatId].shift();
  }
}

function getBaseOptions(threadId) {
    const opts = { parse_mode: 'Markdown', disable_web_page_preview: true };
    if (threadId) opts.message_thread_id = threadId;
    return opts;
}

function getReplyOptions(msg) {
    return { reply_to_message_id: msg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true };
}

function getActionOptions(threadId) {
    if (!threadId) return undefined;
    return { message_thread_id: threadId };
}

async function processBuffer(chatId) {
    const buffer = analysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;
    
    log("BUFFER", "Запуск анализа для " + buffer.length + " сообщений");
    
    const userIds = [...new Set(buffer.map(m => m.userId))];
    const currentProfiles = storage.getProfilesForUsers(chatId, userIds);
    
    try {
        const updates = await ai.analyzeBatch(buffer, currentProfiles);
        
        if (updates) {
            storage.bulkUpdateProfiles(chatId, updates);
            log("BUFFER", "[OBSERVER] Обновлено профилей: " + Object.keys(updates).length);
        }
    } catch (e) {
        log("BUFFER ERROR", e.message);
    }
    
    analysisBuffers[chatId] = [];
}

async function processMessage(bot, msg) {
    // === 0. ИНИЦИАЛИЗАЦИЯ ПЕРЕМЕННЫХ ===
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    let threadId = msg.is_topic_message ? msg.message_thread_id : (msg.message_thread_id || (msg.reply_to_message ? msg.reply_to_message.message_thread_id : null));
    if (typeof threadId !== 'number') threadId = null;
    
    let text = msg.text || msg.caption || "";
    const cleanText = text.toLowerCase();
    
    // ВАЖНО: Объявляем переменную здесь, чтобы она была доступна во всей функции
    const urlRegex = /(https?:\/\/[^\s]+)/;
    const foundLink = text.match(urlRegex);
    
    log("PROCESS", "Chat: " + chatId + " | User: " + userId + " | Text: " + text.substring(0, 50));
    log("DEBUG_LINK", "Ссылка найдена: " + !!foundLink);

    // === КОНТРОЛЛЕР СТАТУСА "ПЕЧАТАЕТ" ===
    let typingTimer = null;
    let safetyTimeout = null;

    const stopTyping = () => {
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
        if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
    };

    const startTyping = () => {
        if (typingTimer) return;
        const sendAction = () => {
            if (threadId) bot.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
            else bot.sendChatAction(chatId, 'typing').catch(() => {});
        };
        sendAction();
        typingTimer = setInterval(sendAction, 4000);
        safetyTimeout = setTimeout(() => { stopTyping(); }, 20000); // 20 сек макс
    };

    const command = text.trim().split(/[\s@]+/)[0].toLowerCase(); 
    const chatTitle = msg.chat.title || msg.chat.username || msg.chat.first_name || "Unknown";

    // === ГЛОБАЛЬНЫЙ БЛОК TRY-CATCH ===
    try {

        // === 1. УВЕДОМЛЕНИЕ О НОВОМ ЧАТЕ ===
        if (!storage.hasChat(chatId) && chatId !== config.adminId) {
            log("SECURITY", "Новый чат обнаружен: " + chatTitle + " (" + chatId + ")");
            
            let alertText = "🔔 **НОВЫЙ КОНТАКТ!**\n\n📂 **Чат:** " + chatTitle + "\n🆔 **ID:** `" + chatId + "`\n";
            const inviter = "@" + (msg.from.username || "нет") + " (" + msg.from.first_name + ")";
            alertText += "👤 **Пишет:** " + inviter + "\n💬 **Текст:** " + text;
            
            bot.sendMessage(config.adminId, alertText, { parse_mode: 'Markdown' }).catch(() => {});
        }

        storage.updateChatName(chatId, chatTitle);

        // === 2. ЛИЧКА: ЗАЩИТА ОТ ЧУЖИХ ===
        if (msg.chat.type === 'private' && userId !== config.adminId) {
            log("SECURITY", "Попытка доступа в ЛС от " + msg.from.first_name);
            
            const senderInfo = "@" + (msg.from.username || "нет") + " (" + msg.from.first_name + ")";
            let contentReport = text ? ("💬 " + text) : "📎 [Файл/Стикер]";
            bot.sendMessage(config.adminId, "📩 **ЛС от " + senderInfo + ":**\n" + contentReport, { parse_mode: 'Markdown' }).catch(() => {});

            if (command !== '/start') {
                await bot.sendMessage(chatId, "Извини, я личный ассистент и настроена на общение только со своим владельцем.", { parse_mode: 'Markdown' });
                return;
            }
        }
    
        if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
            log("SECURITY", "Админ покинул чат. Бот выходит.");
            await bot.sendMessage(chatId, "Мой человек ушел, я тоже отключаюсь.");
            await bot.leaveChat(chatId);
            return;
        }

        // === 3. ОБРАБОТКА ГОЛОСОВЫХ ===
        if (msg.voice || msg.audio) {
            log("VOICE", "Получено голосовое сообщение. Начинаю транскрипцию...");
            startTyping(); 
            try {
                const media = msg.voice || msg.audio;
                const link = await bot.getFileLink(media.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(resp.data);
                const mimeType = msg.voice ? 'audio/ogg' : (media.mime_type || 'audio/mpeg');
                const userName = msg.from.first_name || "Собеседник";

                const transcription = await ai.transcribeAudio(buffer, userName, mimeType);
                
                stopTyping();

                if (transcription) {
                    log("VOICE", "Транскрипция успешна: " + transcription.text.substring(0,30));
                    text = transcription.text; 
                    msg.text = transcription.text;

                    await bot.sendMessage(chatId, "🎤 **Расшифровка:**\n_" + transcription.text + "_", getReplyOptions(msg));
                }
            } catch (e) { 
                log("VOICE ERROR", e.message);
                console.error("Ошибка голосового:", e.message); 
            }
        }

        if (!text && !msg.photo && !msg.sticker && !msg.voice && !msg.audio) return;

        if (msg.chat.type !== 'private') {
            storage.trackUser(chatId, msg.from);
        }

        // === 4. НАБЛЮДАТЕЛЬ (БУФЕР) ===
        const senderName = msg.from.first_name || "User";
        const senderUsername = msg.from.username ? "@" + msg.from.username : "";
        const displayName = senderUsername ? (senderName + " (" + senderUsername + ")") : senderName;

        if (!text.startsWith('/')) {
            if (!analysisBuffers[chatId]) {
                analysisBuffers[chatId] = [];
            }
            analysisBuffers[chatId].push({ userId, name: displayName, text });
            if (analysisBuffers[chatId].length >= BUFFER_SIZE) {
                processBuffer(chatId); 
            }
        }

        // === 5. КОМАНДЫ ===
        if (command === '/reset') {
            log("CMD", "Выполнен сброс контекста (/reset)");
            chatHistory[chatId] = [];
            analysisBuffers[chatId] = [];
            return bot.sendMessage(chatId, "🧹 Я очистила контекст диалога. Можем начать новую тему.", getBaseOptions(threadId));
        }

        if (command === '/restart' && userId === config.adminId) {
            log("CMD", "Запрошен рестарт (/restart)");
            await bot.sendMessage(chatId, "🔄 Перезагружаюсь...", getBaseOptions(threadId));
            exec('pm2 restart sych-bot', () => {});
            return;
        }

        if (command === '/mute') {
            const nowMuted = storage.toggleMute(chatId, threadId);
            log("CMD", "Mute status changed to: " + nowMuted);
            return bot.sendMessage(chatId, nowMuted ? "🤫 Хорошо, я помолчу." : "👋 Я снова слушаю.", getBaseOptions(threadId));
        }

        if (storage.isTopicMuted(chatId, threadId)) return;

        // === НАЧАЛО ОБРАБОТКИ ОТВЕТА ===
        startTyping();
        addToHistory(chatId, senderName, text);

        // === 6. YOUTUBE ПОЛНЫЙ ЦИКЛ ===
        const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;

        if (foundLink && ytRegex.test(foundLink[0])) {
            const url = foundLink[0];
            log("YOUTUBE", "Обработка видео: " + url);
            startTyping();

            try {
                await bot.sendChatAction(chatId, 'typing');
                
                const data = await youtube.getTranscript(url);
                
                if (!data) {
                    stopTyping();
                    await bot.sendMessage(chatId, "⚠️ У этого видео нет субтитров, я не могу его прочитать.", getReplyOptions(msg));
                    return;
                }

                await bot.sendMessage(chatId, "🎬 **Субтитры получены.**\nНачинаю редактуру и оформление (это займет 10-20 сек)...");
                startTyping();

                // === НОВОЕ: Проверка на куки и отправка сообщения ===
                if (data.usedCookies) {
                    await bot.sendMessage(chatId, "🍪 использовала куки.", getReplyOptions(msg));
                }
                // ====================================================

                const markdownContent = await ai.processYouTubeTranscript(data.title, data.text);
                const savedFileName = parser.saveDirectContent(data.title, markdownContent);
                
                stopTyping();

                await bot.sendMessage(chatId, 
                    "✅ **Видео обработано и сохранено!**\n\n📄 **Файл:** _" + savedFileName + "_\n🧠 **Что сделано:** Саммари + Полный текст.\n📂 **Папка:** Inbox", 
                    getReplyOptions(msg)
                );
                
                return;

            } catch (e) {
                console.error(e);
                stopTyping();
                await bot.sendMessage(chatId, "⚠️ Ошибка обработки видео: " + e.message);
            }
        }


        // === 7. ВЕБ-КЛИППЕР ===
        if (foundLink && text.length < 500 && !text.includes("/img")) {
            const url = foundLink[0];
            log("PARSER", "Обнаружена ссылка для парсинга: " + url);
            startTyping();
            
            try {
                await bot.sendChatAction(chatId, 'upload_document'); 
                const title = await parser.saveArticle(url);
                log("PARSER", "Статья сохранена: " + title);
                stopTyping();
                
                await bot.sendMessage(chatId, 
                    "✍️ **Добавила эту заметку тебе в блокнот.**\n\n📄 **Название:** _" + title + "_\n📂 **Статус:** ✅ Успешно", 
                    getReplyOptions(msg)
                );
                
                return;

            } catch (e) {
                log("PARSER ERROR", e.message);
                stopTyping();
                await bot.sendMessage(chatId, 
                    "⚠️ **Не удалось сохранить заметку.**\n\nЯ попыталась, но возникла ошибка: _" + e.message + "_\n\n_(Тем не менее, я могу обсудить эту статью, если хочешь)_",
                    getReplyOptions(msg)
                );
            }
        }

        // === 8. НАПОМИНАЛКИ ===
        if (cleanText.includes("напомни") || cleanText.includes("напоминай")) {
            log("FEATURE", "Обработка напоминания: " + text);
            const replyContent = msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") : "";
            
            const parsed = await ai.parseReminder(text, replyContent);
            
            if (parsed && parsed.targetTime) {
                const username = msg.from.username ? ("@" + msg.from.username) : msg.from.first_name;
                storage.addReminder(chatId, userId, username, parsed.targetTime, parsed.reminderText);
                
                stopTyping();
                return bot.sendMessage(chatId, parsed.confirmation, getReplyOptions(msg));
            }
        }

        // === 9. ФИЧИ ===
        const aboutMatch = cleanText.match(/(?:расскажи про|кто так(?:ой|ая)|мнение о|поясни за)\s+(.+)/);
        if (aboutMatch) {
            log("FEATURE", "Запрос информации о профиле");
            const targetName = aboutMatch[1].replace('?', '').trim();
            const targetProfile = storage.findProfileByQuery(chatId, targetName);
            if (targetProfile) {
                const description = await ai.generateProfileDescription(targetProfile, targetName);
                stopTyping();
                try { return await bot.sendMessage(chatId, description, getReplyOptions(msg)); } catch(e){}
                return;
            }
        }
        
        if (cleanText.match(/(монетк|кинь|брось|подбрось|подкинь)/)) {
            const result = Math.random() > 0.5 ? "ОРЁЛ" : "РЕШКА";
            const flavor = await ai.generateFlavorText("подбросить монетку", result);
            try { return await bot.sendMessage(chatId, flavor, getReplyOptions(msg)); } catch(e){}
            stopTyping();
            return;
        }

        const rangeMatch = cleanText.match(/(\d+)-(\d+)/);
        if ((cleanText.includes("число") || cleanText.includes("рандом")) && rangeMatch) {
            const min = parseInt(rangeMatch[1]);
            const max = parseInt(rangeMatch[2]);
            const rand = Math.floor(Math.random() * (max - min + 1)) + min;
            const flavor = await ai.generateFlavorText("выбрать число " + min + "-" + max, String(rand));
            try { return await bot.sendMessage(chatId, flavor, getReplyOptions(msg)); } catch(e){}
            stopTyping();
            return;
        }

        // === 10. РЕАКЦИИ ===
        if (text.length > 10 && !msg.reply_to_message && Math.random() < 0.20) {
            const historyBlock = chatHistory[chatId].slice(-10).map(m => (m.role + ": " + m.text)).join('\n');
            ai.determineReaction(historyBlock + "\nСообщение: " + text).then(async (emoji) => {
                if (emoji) {
                    try { await bot.setMessageReaction(chatId, msg.message_id, { reaction: [{ type: 'emoji', emoji: emoji }] }); } catch (e) {}
                }
            });
        }

        // === 11. ПОДГОТОВКА ОТВЕТА (ОСНОВНОЙ БЛОК) ===
        let imageBuffer = null;
        let mimeType = "image/jpeg"; 

        // === МЕДИА ===
        if (msg.sticker) {
            const stickerEmoji = msg.sticker.emoji || "";
            if (stickerEmoji) text += " [Отправлен стикер: " + stickerEmoji + "]";

            if (!msg.sticker.is_animated && !msg.sticker.is_video) {
                try {
                    const link = await bot.getFileLink(msg.sticker.file_id);
                    const resp = await axios.get(link, { responseType: 'arraybuffer' });
                    imageBuffer = Buffer.from(resp.data);
                    mimeType = "image/webp";
                    log("MEDIA", "Обработан стикер");
                } catch (e) {}
            }
        }
        else if (msg.photo || (msg.reply_to_message && msg.reply_to_message.photo)) {
        try {
            const photoObj = msg.photo ? msg.photo[msg.photo.length-1] : msg.reply_to_message.photo[msg.reply_to_message.photo.length-1];
            const link = await bot.getFileLink(photoObj.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = "image/jpeg";
            log("MEDIA", "Обработано фото");
        } catch(e) {}
        }
        else if (msg.video || (msg.reply_to_message && msg.reply_to_message.video)) {
            const vid = msg.video || msg.reply_to_message.video;
            if (vid.file_size > 20 * 1024 * 1024) {
                return bot.sendMessage(chatId, "🐢 Видео слишком большое (>20 Мб), я не смогу его посмотреть.", getReplyOptions(msg));
            }
            try {
                await bot.sendChatAction(chatId, 'upload_video', getActionOptions(threadId));
                const link = await bot.getFileLink(vid.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                mimeType = vid.mime_type || "video/mp4";
                log("MEDIA", "Обработано видео");
            } catch(e) {}
        }
        else if (msg.document || (msg.reply_to_message && msg.reply_to_message.document)) {
            const doc = msg.document || msg.reply_to_message.document;
            const allowedMimes = ['application/pdf', 'text/plain', 'text/md', 'text/csv', 'text/xml', 'text/rtf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

            if (doc.file_size > 20 * 1024 * 1024) {
                return bot.sendMessage(chatId, "🐘 Файл слишком тяжелый (>20 Мб).", getReplyOptions(msg));
            }
            if (!allowedMimes.includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {
                return bot.sendMessage(chatId, "📄 Я могу прочитать только текстовые файлы (PDF, DOCX, TXT).", getReplyOptions(msg));
            }

            try {
                await bot.sendChatAction(chatId, 'upload_document', getActionOptions(threadId));
                const link = await bot.getFileLink(doc.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                mimeType = doc.mime_type;
                log("MEDIA", `Обработан документ: ${doc.mime_type}`);
            } catch(e) {}
        }
        else if (!imageBuffer) {
            let imgMatch = text.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif)/i);
            if (imgMatch) {
                try {
                    const resp = await axios.get(imgMatch[0], { responseType: 'arraybuffer' });
                    imageBuffer = Buffer.from(resp.data);
                    mimeType = "image/jpeg";
                    log("MEDIA", "Скачано изображение по ссылке");
                } catch(e) {}
            }
        }

        const instruction = msg.from.username ? storage.getUserInstruction(msg.from.username) : "";
        const userProfile = storage.getProfile(chatId, userId);

        let aiResponse = "";
        
        try {
            log("AI", "Отправляю запрос к модели...");
            const replyText = msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") : "";

            aiResponse = await ai.getResponse(
                chatHistory[chatId], 
                { sender: senderName, text: text, replyText: replyText }, 
                imageBuffer, 
                mimeType,
                instruction,
                userProfile,
                false 
            );

            if (!aiResponse) aiResponse = getAnnaErrorReply("503 overloaded");
            
            log("AI", "Ответ получен. Длина: " + aiResponse.length + " символов.");
        
        } catch (err) {
            log("AI ERROR", err.message);
            console.error("[AI ERROR]:", err.message);
            aiResponse = getAnnaErrorReply(err.message);
        }

        // === 12. ОТПРАВКА ===
        try {
            let formattedResponse = aiResponse
                .replace(/^#{1,6}\s+(.*?)$/gm, '\n*$1*')
                .replace(/\*\*([\s\S]+?)\*\*/g, '*$1*')
                .replace(/^(\s*)[\*\-]\s+/gm, '$1• ');

            if (formattedResponse.length > 8500) {
                formattedResponse = formattedResponse.substring(0, 8500) + "...";
            }

            let chunks = formattedResponse.match(/[\s\S]{1,4000}/g) || [formattedResponse];
            
            if (chunks.length === 0 && formattedResponse.length > 0) chunks = [formattedResponse];

            log("SEND", "Начинаю отправку сообщения (" + chunks.length + " частей)...");

            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
            }

            stopTyping();
            addToHistory(chatId, "Анна", aiResponse);
            log("SEND", "Сообщение успешно отправлено.");

        } catch (error) {
            stopTyping();
            log("SEND ERROR", error.message + ". Пробую отправку без Markdown.");
            try { 
                await bot.sendMessage(chatId, aiResponse, { reply_to_message_id: msg.message_id });
            } catch (e2) {
                log("FATAL", "Не удалось отправить сообщение.");
            }
        }

        // === 13. ФОНОВЫЙ АНАЛИЗ ===
        const contextForAnalysis = chatHistory[chatId].slice(-5).map(m => (m.role + ": " + m.text)).join('\n');
        ai.analyzeUserImmediate(contextForAnalysis, userProfile).then(updated => {
            if (updated) {
                const updates = {}; updates[userId] = updated;
                storage.bulkUpdateProfiles(chatId, updates);
            }
        }).catch(() => {});

    } catch (fatalError) {
        log("FATAL ERROR", fatalError.stack || fatalError.message);
        stopTyping();
    }
}

module.exports = { processMessage };