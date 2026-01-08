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

// Хранилища временных данных в оперативной памяти
const chatHistory = {};       // История диалогов для контекста AI
const analysisBuffers = {};   // Буфер для накопления текстов перед анализом
const BUFFER_SIZE = 20;       // Лимит строк в буфере анализа

// Настройки отладки
const DEBUG = true; 

/**
 * Системный логгер с меткой времени.
 * Помогает отслеживать путь сообщения через фильтры.
 */
function log(tag, message) {
    if (DEBUG) {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`[${timestamp}][${tag}] ${message}`);
    }
}

// ============================================================
// БЛОК 2: УТИЛИТЫ ФОРМАТИРОВАНИЯ И TELEGRAM API
// ============================================================

/**
 * Подблок: Генерация ответов на ошибки.
 * Превращает сухие технические ошибки в понятный пользователю текст.
 */
function getAnnaErrorReply(errText) {
    const error = errText.toLowerCase();
    if (error.includes('prohibited') || error.includes('safety')) return "🛑 Ошибка безопасности AI.";
    if (error.includes('503') || error.includes('overloaded')) return "💤 Сервера перегружены.";
    return "🛠 Технический сбой.";
}

/**
 * Подблок: Опции сообщений.
 * Настраивает Markdown и привязку ответа (Reply) к исходному сообщению.
 */
function getReplyOptions(msg) {
    return { 
        reply_to_message_id: msg.message_id, 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true 
    };
}

/**
 * Подблок: Извлечение URL (Smart Search).
 * Ищет ссылки в тексте, подписях и скрытых гиперссылках (entities).
 */
function extractUrl(message) {
    const entities = message.entities || message.caption_entities || [];
    // Сначала ищем в сущностях (пересланные посты, кнопки)
    for (const entity of entities) {
        if (entity.type === 'text_link') return entity.url;
        if (entity.type === 'url') {
            const raw = message.text || message.caption || "";
            return raw.substring(entity.offset, entity.offset + entity.length);
        }
    }
    // Если сущностей нет, ищем регулярным выражением
    const match = (message.text || message.caption || "").match(/(https?:\/\/[^\s]+)/);
    return match ? match[0] : null;
}

// ============================================================
// БЛОК 3: ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ (PROCESSMESSAGE)
// ============================================================

async function processMessage(bot, msg) {
    // --- 3.1. Инициализация контекста ---
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let text = msg.text || msg.caption || "";
    const foundUrl = extractUrl(msg); // Извлекаем URL через Smart Search
    
    log("PROCESS", `Chat: ${chatId} | Msg: ${text.substring(0, 30)}...`);

    // --- 3.2. Управление индикацией "typing" ---
    let typingTimer = null;
    const stopTyping = () => { if (typingTimer) { clearInterval(typingTimer); typingTimer = null; } };
    const startTyping = () => {
        if (typingTimer) return;
        const action = () => { bot.sendChatAction(chatId, 'typing').catch(() => {}); };
        action();
        typingTimer = setInterval(action, 4000);
    };

    try {
        // --- 3.3. БОТ-ФИЛЬТР: ГОЛОСОВЫЕ И АУДИО ---
        if (msg.voice || msg.audio) {
            startTyping();
            const media = msg.voice || msg.audio;
            const link = await bot.getFileLink(media.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            const transcription = await ai.transcribeAudio(Buffer.from(resp.data), msg.from.first_name);
            text = transcription.text; // Передаем текст дальше для AI-ответа
            await bot.sendMessage(chatId, "🎤 Расшифровка:\n" + text);
        }

        // --- 3.4. БОТ-ФИЛЬТР: YOUTUBE VISION (NATIVE) ---
        if (foundUrl && (foundUrl.includes('youtube.com') || foundUrl.includes('youtu.be'))) {
            log("YOUTUBE", "Запуск Vision анализа...");
            startTyping();
            try {
                // Видео-сервис сам вернет {title, analysis} на основе AI-просмотра
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

        // --- 3.5. БОТ-ФИЛЬТР: ВЕБ-КЛИППЕР (СТАТЬИ) ---
        if (foundUrl && text.length < 500) {
            startTyping();
            const title = await parser.saveArticle(foundUrl);
            stopTyping();
            await bot.sendMessage(chatId, "✍️ Заметка сохранена: " + title, getReplyOptions(msg));
            return;
        }

        // --- 3.6. БОТ-ФИЛЬТР: МЕДИА-АНАЛИЗ (PHOTO/STICKER) ---
        let imageBuffer = null;
        if (msg.photo || (msg.sticker && !msg.sticker.is_animated)) {
            const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.sticker.file_id;
            const link = await bot.getFileLink(fileId);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
        }

        // --- 3.7. ЯДРО: ГЕНЕРАЦИЯ ОТВЕТА AI ---
        if (text || imageBuffer) {
            startTyping();
            
            // Подготовка инструкций и контекста
            const instruction = storage.getUserInstruction(msg.from.username || "");
            const userProfile = storage.getProfile(chatId, userId);
            const history = chatHistory[chatId] || [];

            // Запрос к AI
            const aiResponse = await ai.getResponse(history, { text }, imageBuffer, "image/jpeg", instruction, userProfile);
            
            // Нарезка ответа на чанки для обхода лимитов Telegram (4096 симв.)
            const chunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
            }

            stopTyping();
            
            // Сохранение в историю и фоновый анализ
            addToHistory(chatId, msg.from.first_name, text);
            addToHistory(chatId, "Анна", aiResponse);
        }

    } catch (fatalError) {
        log("FATAL", fatalError.message);
        stopTyping();
    }
}

module.exports = { processMessage };