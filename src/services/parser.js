const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

async function processContentWithAI(text, sourceUrl) {
    if (!genAI) return null;
    const model = genAI.getGenerativeModel(MODEL_CONFIG);
    const prompt = `
    Ты — технический редактор. Переведи и законспектируй этот текст.
    ЯЗЫК: СТРОГО РУССКИЙ.
    СТРУКТУРА:
    TITLE: [Заголовок на русском]
    # [Заголовок]
    🔗 Источник: ${sourceUrl}
    ## Суть
    [1-2 предложения]
    ## Конспект
    [Ключевые идеи]
    `;

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
        return null;
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
    // Эта функция осталась без изменений, она работает корректно в твоем файле
    // Я не привожу её полный код здесь для краткости, она не влияет на текущие ошибки
}

async function saveArticle(url) {
    try {
        console.log(`[PARSER] Качаю статью: ${url}`);
        
        // [ИСПРАВЛЕНИЕ] Добавлены заголовки против блокировок (401)
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://www.google.com/'
            },
            timeout: 15000 
        });

        const doc = new JSDOM(response.data, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        if (!article) throw new Error("Не удалось извлечь текст (защита или пусто).");

        const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        turndownService.remove(['script', 'style', 'iframe', 'nav', 'footer']);
        const rawMarkdown = turndownService.turndown(article.content);

        let finalTitle = article.title;
        let finalBody = rawMarkdown;

        console.log(`[PARSER] Отправляю в AI...`);
        const aiResult = await processContentWithAI(rawMarkdown.substring(0, 30000), url);

        if (aiResult) {
            finalTitle = aiResult.title;
            finalBody = aiResult.body;
        }

        const date = new Date().toISOString().split('T')[0];
        const fileName = sanitizeFilename(finalTitle || "Article");
        const safeYamlTitle = (finalTitle || "Article").replace(/"/g, '\\"');

        const fileContent = `---
title: "${safeYamlTitle}"
url: ${url}
date: ${date}
tags: [inbox, article]
---

${finalBody}
`;

        if (!fs.existsSync(OBSIDIAN_PATH)) fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
        fs.writeFileSync(path.join(OBSIDIAN_PATH, fileName), fileContent);
        console.log(`[PARSER] Файл создан: ${fileName}`);

        return finalTitle;

    } catch (error) {
        console.error("[PARSER ERROR]:", error.message);
        throw error; 
    }
}

module.exports = { saveArticle, saveDirectContent, saveForwardedMessage };