const { GoogleGenerativeAI } = require("@google/generative-ai");

// ==========================================
// БЛОК 1: ИНИЦИАЛИЗАЦИЯ И НАСТРОЙКИ
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Настройки модели (вынесено отдельно для удобства смены модели)
const MODEL_CONFIG = {
    model: "gemini-2.0-flash",
    timeout: 600000 // 10 минут
};

// ==========================================
// БЛОК 2: ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (CLEANERS)
// ==========================================

// Очистка ответа Gemini от Markdown-мусора
function cleanGeminiOutput(text) {
    if (!text) return "";
    return text
        .replace(/```[a-z]*\n?/gi, '') 
        .replace(/```/g, '')
        .replace(/[*_`]/g, '')
        .trim();
}

// Защита имени файла для файловой системы
function sanitizeTitle(title) {
    if (!title) return "Video_Note_" + Date.now();
    let clean = cleanGeminiOutput(title).replace(/^TITLE:\s*/i, '');
    return clean
        .replace(/[\\/!?:*|"<>]/g, '') 
        .replace(/\s+/g, '_')
        .substring(0, 80)
        .trim();
}

// ==========================================
// БЛОК 3: ОСНОВНАЯ ЛОГИКА АНАЛИЗА
// ==========================================

async function processVideo(youtubeUrl) {
    const model = genAI.getGenerativeModel(
        { model: MODEL_CONFIG.model },
        { timeout: MODEL_CONFIG.timeout }
    );

    console.log(`[VISION] Анализ URL (${MODEL_CONFIG.model}): ${youtubeUrl}`);

    const prompt = `
    Проанализируй это видео. 
    
    ШАГ 1: Напиши название файла (на русском).
    - ТОЛЬКО текст, без markdown.
    - Начни строку с "TITLE: ".
    
    ШАГ 2: Подробный технический конспект (Markdown).
    - Источник: ${youtubeUrl}
    - Тезисы, софт, алгоритмы.
    `;

    try {
        const result = await model.generateContent([
            {
                fileData: {
                    mimeType: "video/mp4", 
                    fileUri: youtubeUrl // Native Bridge
                }
            },
            { text: prompt }
        ]);

        const fullResponse = result.response.text();
        const lines = fullResponse.split('\n');
        
        // Извлечение заголовка
        let rawTitle = lines.find(l => l.startsWith('TITLE:')) || lines[0];
        const cleanTitle = sanitizeTitle(rawTitle);
        
        // Извлечение конспекта
        const analysisText = lines.filter(l => !l.startsWith('TITLE:')).join('\n').trim();

        return {
            title: cleanTitle.length > 2 ? cleanTitle : `Video_${Date.now()}`,
            analysis: analysisText
        };
    } catch (error) {
        console.error("[GEMINI_ERROR]", error.message);
        throw new Error("Ошибка API Gemini: " + error.message);
    }
}

module.exports = { processVideo };