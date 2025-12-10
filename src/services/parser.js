const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Путь, куда мы смонтировали папку в docker-compose
const OBSIDIAN_PATH = '/app/obsidian_inbox';

async function saveArticle(url) {
    try {
        console.log(`[PARSER] Качаю статью: ${url}`);
        
        // 1. Скачиваем HTML (притворяемся обычным браузером)
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            },
            timeout: 10000 
        });
        const html = response.data;

        // 2. Выделяем основной текст (Readability)
        const doc = new JSDOM(html, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        if (!article) throw new Error("Не удалось извлечь текст (защита от парсинга или пустая страница).");

        // 3. Конвертируем в Markdown
        const turndownService = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced'
        });
        // Настройка: убираем лишние скрипты и стили, если просочились
        turndownService.remove(['script', 'style', 'iframe']);

        const markdownBody = turndownService.turndown(article.content);

        // 4. Формируем имя файла и контент
        const date = new Date().toISOString().split('T')[0];
        // Чистим имя файла от запрещенных символов
        const safeTitle = (article.title || "No Title").replace(/[\\/:*?"<>|]/g, '-').trim(); 
        const fileName = `${safeTitle}.md`;
        
        const fileContent = `---
title: "${article.title}"
url: ${url}
date: ${date}
tags: [inbox, from_anna]
---

# ${article.title}

${markdownBody}

---
*Сохранено Анной: ${new Date().toLocaleString()}*
`;

        // 5. Сохраняем
        if (!fs.existsSync(OBSIDIAN_PATH)) {
             // Если папки нет внутри контейнера - пытаемся создать (но лучше чтобы она была при маунте)
             fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
        }

        const fullPath = path.join(OBSIDIAN_PATH, fileName);
        fs.writeFileSync(fullPath, fileContent);
        console.log(`[PARSER] Сохранено: ${fullPath}`);

        return article.title;

    } catch (error) {
        console.error("[PARSER ERROR]:", error.message);
        throw error; // Прокидываем ошибку наверх, чтобы бот ответил
    }
}

module.exports = { saveArticle };