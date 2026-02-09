require('dotenv').config();

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),
  
  // Scraper Keys
  jinaKey: process.env.JINA_API_KEY,   // <--- Добавили
  tavilyKey: process.env.TAVILY_API_KEY, // <--- Добавили

  // === НАСТРОЙКИ AI (OPENROUTER) ===
  geminiKeys: [process.env.OPENROUTER_API_KEY],
  aiApiKey: process.env.OPENROUTER_API_KEY,
  aiBaseUrl: "https://openrouter.ai/api/v1",
  
  // [ИСПРАВЛЕНО] Gemini по умолчанию
  modelName: process.env.AI_MODEL || "google/gemini-2.5-flash-lite",

  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(анна|anna)(?![а-яёa-z])/i,
};