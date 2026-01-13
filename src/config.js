require('dotenv').config();

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),

  // === НАСТРОЙКИ AI (OPENROUTER) ===
  geminiKeys: [process.env.OPENROUTER_API_KEY],
  aiApiKey: process.env.OPENROUTER_API_KEY,
  aiBaseUrl: "https://openrouter.ai/api/v1",
  
  // [ИСПРАВЛЕНИЕ] Дефолтная модель теперь Gemini 2.5 (как в меню)
  // modelName: process.env.AI_MODEL || "google/gemini-2.5-flash-lite",
  // Ставим Lite версию по умолчанию
  modelName: process.env.AI_MODEL || "google/gemini-2.5-flash-lite-preview-02-05:free",

  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(анна|anna)(?![а-яёa-z])/i,
};