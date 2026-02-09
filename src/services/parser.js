const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// === ИМПОРТЫ ===
const prompts = require('../core/prompts');
const scraper = require('../core/scraper'); // Подключаем новый модуль

const OBSIDIAN_PATH = '/app/obsidian_inbox';
const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;
const MODEL_CONFIG = { model: "gemini-2.0-flash", timeout: 600000 };

function sanitizeFilename(text) {
    if (!text) return `untitled_${Date.now()}.md`;
    let clean = text.replace(/[\\/:*?"<>|\n\r]/g, '-').replace(/\s+/g, " ").trim();
    if (clean.length > 60) clean = clean.substring(0, 60).trim();
    if (!clean) clean = `note_${Date.now()}`;
    return clean + ".md";
}

// === ЛОГИКА AI (ОСТАЕТСЯ БЕЗ ИЗМЕНЕНИЙ) ===
async function processContentWithAI(text, sourceUrl) {
    if (!genAI) return null;
    const model = genAI.getGenerativeModel(MODEL_CONFIG);
    
    // Берем промпт из prompts.js
    const prompt = prompts.articleParser(sourceUrl);

    try {
        const result = await model.generateContent([prompt, text].join("\n\n---\n\n"));
        const responseText = result.response.text();
        const lines = responseText.split('\n');
        
        let title = "AI_Article";
        const titleLine = lines.find(l => l.startsWith('TITLE:'));
        if (titleLine) title = titleLine.replace('TITLE:', '').trim();
        
        const body = lines.filter(l => !l.startsWith('TITLE:')).join('\n').trim();
        return { title, body };
    } catch (e) {
        console.warn("[PARSER] AI error:", e.message);
        return null; // Если AI упал, вернем сырой текст
    }
}

function saveDirectContent(fileNameTitle, content) {
    const fileName = sanitizeFilename(fileNameTitle);
    if (!fs.existsSync(OBSIDIAN_PATH)) fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
    fs.writeFileSync(path.join(OBSIDIAN_PATH, fileName), content);
    console.log(`[FILE] Saved: ${fileName}`);
    return fileName;
}

function saveForwardedMessage(messageText, senderName, senderUsername, chatName, messageId, chatId) {
   // (Функция-заглушка или старая реализация, нужна для экспорта, если используется)
}

// === НОВАЯ ЛОГИКА СКАЧИВАНИЯ (ЧЕРЕЗ SCRAPER CORE) ===
async function saveArticle(url) {
    try {
        console.log(`[PARSER] Старт обработки: ${url}`);
        
        // 1. Извлекаем контент через каскад (Jina -> Tavily)
        const scrapedData = await scraper.extract(url);
        
        // Ограничиваем длину перед AI (экономия токенов)
        const rawMarkdown = scrapedData.content.substring(0, 45000); 
        console.log(`[PARSER] Скачано ${rawMarkdown.length} символов. Метод: ${scrapedData.method}`);

        // 2. Отправляем в AI на структурирование
        let finalTitle = scrapedData.title || "WebArticle";
        let finalBody = rawMarkdown;

        console.log(`[PARSER] Отправляю в AI...`);
        const aiResult = await processContentWithAI(rawMarkdown, url);

        if (aiResult) {
            finalTitle = aiResult.title;
            finalBody = aiResult.body;
        }

        // 3. Сохранение в Obsidian
        const date = new Date().toISOString().split('T')[0];
        const fileName = sanitizeFilename(finalTitle);
        const safeYamlTitle = finalTitle.replace(/"/g, '\\"');

        const fileContent = `---
title: "${safeYamlTitle}"
url: ${url}
date: ${date}
tags: [inbox, article, ${scrapedData.method}]
---

${finalBody}
`;

        if (!fs.existsSync(OBSIDIAN_PATH)) fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
        fs.writeFileSync(path.join(OBSIDIAN_PATH, fileName), fileContent);
        console.log(`[PARSER] Файл успешно создан: ${fileName}`);

        return finalTitle;

    } catch (error) {
        console.error("[PARSER ERROR]:", error.message);
        throw error; 
    }
}

module.exports = { saveArticle, saveDirectContent, saveForwardedMessage };