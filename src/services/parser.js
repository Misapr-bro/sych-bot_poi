const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================
// БЛОК 1: КОНФИГУРАЦИЯ И КОНСТАНТЫ
// ============================================================

// Путь к папке Obsidian в Docker-контейнере
const OBSIDIAN_PATH = '/app/obsidian_inbox';

// Инициализация AI для перевода статей (если ключ есть)
const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
const MODEL_CONFIG = { model: "gemini-2.0-flash", timeout: 600000 };

// ============================================================
// БЛОК 2: ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (УТИЛИТЫ)
// ============================================================

/**
 * Подблок: Безопасное имя файла.
 * Чистит строку от запрещенных символов и обрезает длину до лимитов ФС.
 */
function sanitizeFilename(text) {
    if (!text) return `untitled_${Date.now()}.md`;

    // 1. Убираем запрещенные символы (/:*?"<>| и переносы)
    let clean = text.replace(/[\\/:*?"<>|\n\r]/g, '-');
    // 2. Убираем лишние пробелы
    clean = clean.replace(/\s+/g, " ").trim();
    // 3. Обрезаем длину (60 симв = ~120 байт, запас для ext4 есть)
    const MAX_LENGTH = 60;
    
    if (clean.length > MAX_LENGTH) {
        clean = clean.substring(0, MAX_LENGTH).trim();
    }
    // Если после чистки пусто
    if (!clean) clean = `note_${Date.now()}`;

    return clean + ".md";
}

/**
 * Подблок: AI-Обработка контента (Перевод и Саммари).
 * Превращает сырой текст статьи в структурированный Markdown на русском.
 */
async function processContentWithAI(text, sourceUrl) {
    if (!genAI) return null; // Если нет ключа, вернем null и сохраним "как есть"

    const model = genAI.getGenerativeModel(MODEL_CONFIG);
    const prompt = `
    Ты — профессиональный технический редактор и переводчик.
    Твоя задача — изучить текст статьи и сделать качественный конспект.

    ЯЗЫКОВОЕ ПРАВИЛО (ВЫСШИЙ ПРИОРИТЕТ):
    - Весь твой ответ должен быть СТРОГО НА РУССКОМ ЯЗЫКЕ.
    - Если исходный текст на английском, немецком или ином языке — делай смысловой перевод.

    СТРУКТУРА ОТВЕТА (Markdown):
    TITLE: [Емкий заголовок на русском]

    # [Заголовок статьи]
    🔗 Источник: ${sourceUrl}

    ## Краткая суть
    [1-2 предложения]

    ## Основной контент (Конспект)
    [Пересказ ключевых идей, кода и выводов]
    `;

    try {
        const result = await model.generateContent([prompt, text].join("\n\n---\n\n"));
        const responseText = result.response.text();
        
        // Парсим ответ (вытаскиваем TITLE)
        const lines = responseText.split('\n');
        let title = "AI_Article";
        const titleLine = lines.find(l => l.startsWith('TITLE:'));
        
        if (titleLine) {
            title = titleLine.replace('TITLE:', '').trim();
        }
        
        // Убираем строку TITLE из тела статьи
        const body = lines.filter(l => !l.startsWith('TITLE:')).join('\n').trim();
        
        return { title, body };
    } catch (e) {
        console.warn("[PARSER] AI error, falling back to raw text:", e.message);
        return null;
    }
}

// ============================================================
// БЛОК 3: ОСНОВНЫЕ ФУНКЦИИ СОХРАНЕНИЯ
// ============================================================

/**
 * Подблок: Прямое сохранение (от видео-анализатора).
 */
function saveDirectContent(fileNameTitle, content) {
    const fileName = sanitizeFilename(fileNameTitle);
    
    if (!fs.existsSync(OBSIDIAN_PATH)) {
        fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
    }

    const fullPath = path.join(OBSIDIAN_PATH, fileName);
    fs.writeFileSync(fullPath, content);
    console.log(`[FILE] Saved: ${fullPath}`);
    return fileName;
}

/**
 * Подблок: Сохранение пересланных сообщений Telegram.
 * Создает frontmatter и сохраняет метаданные отправителя.
 */
function saveForwardedMessage(messageText, senderName, senderUsername, chatName, messageId, chatId) {
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('ru-RU');

    let fullTitle = messageText.trim().substring(0, 100);
    if (messageText.length > 100) fullTitle += '...';
    const safeYamlTitle = fullTitle.replace(/"/g, '\\"');
    const fileName = sanitizeFilename(messageText);

    const username = senderUsername ? `@${senderUsername}` : senderName;
    const telegramLink = chatId < 0
        ? `https://t.me/c/${Math.abs(chatId)}/${messageId}` 
        : `https://t.me/${senderUsername || 'c'}/${messageId}`;

    const fileContent = `---
title: "${safeYamlTitle}"
source: telegram
date: ${date}
sender: "${username}"
chat: "${chatName}"
tags: [inbox, forwarded]
---

# ${fullTitle}

**От:** ${username} | **Чат:** ${chatName} | **Время:** ${time}

## Текст сообщения
${messageText}

---
[🔗 Ссылка на сообщение](${telegramLink})
`;

    if (!fs.existsSync(OBSIDIAN_PATH)) fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
    fs.writeFileSync(path.join(OBSIDIAN_PATH, fileName), fileContent, 'utf-8');
    console.log(`[FORWARD] Сохранено: ${fileName}`);
    return fullTitle;
}

/**
 * Подблок: Веб-клиппер (Статьи) с AI-переводом.
 * 1. Качает HTML.
 * 2. Чистит через Readability + Turndown.
 * 3. Отправляет в AI для перевода и саммари (НОВОЕ).
 */
async function saveArticle(url) {
    try {
        console.log(`[PARSER] Качаю статью: ${url}`);
        
        // 1. Скачивание
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            },
            timeout: 15000 
        });

        // 2. Парсинг структуры (Readability)
        const doc = new JSDOM(response.data, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        if (!article) throw new Error("Не удалось извлечь текст (защита или пусто).");

        // 3. Конвертация в сырой Markdown (Turndown)
        const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        turndownService.remove(['script', 'style', 'iframe', 'nav', 'footer']);
        const rawMarkdown = turndownService.turndown(article.content);

        // 4. AI-Перевод и Структурирование (НОВОЕ)
        let finalTitle = article.title;
        let finalBody = rawMarkdown;

        console.log(`[PARSER] Отправляю в AI для перевода...`);
        const aiResult = await processContentWithAI(rawMarkdown.substring(0, 30000), url); // Лимит на вход 30к символов

        if (aiResult) {
            finalTitle = aiResult.title;
            finalBody = aiResult.body;
            console.log(`[PARSER] AI успешно обработал статью.`);
        }

        // 5. Сохранение файла
        const date = new Date().toISOString().split('T')[0];
        const fileName = sanitizeFilename(finalTitle || "Article");
        const safeYamlTitle = (finalTitle || "Article").replace(/"/g, '\\"');

        const fileContent = `---
title: "${safeYamlTitle}"
url: ${url}
date: ${date}
tags: [inbox, article, ai_translated]
---

${finalBody}

---
*Сохранено Анной: ${new Date().toLocaleString()}*
`;

        if (!fs.existsSync(OBSIDIAN_PATH)) fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
        
        const fullPath = path.join(OBSIDIAN_PATH, fileName);
        fs.writeFileSync(fullPath, fileContent);
        console.log(`[PARSER] Файл создан: ${fullPath}`);

        return finalTitle;

    } catch (error) {
        console.error("[PARSER ERROR]:", error.message);
        throw error; 
    }
}

module.exports = { saveArticle, saveDirectContent, saveForwardedMessage };