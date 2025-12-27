require('dotenv').config();

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),

  // === НАСТРОЙКИ AI (OPENROUTER) ===
  geminiKeys: [process.env.OPENROUTER_API_KEY],
  aiApiKey: process.env.OPENROUTER_API_KEY,
  aiBaseUrl: "https://openrouter.ai/api/v1",
  
  // Qwen 2.5 VL — мощная модель с поддержкой ЗРЕНИЯ (картинок)
  modelName: process.env.AI_MODEL || "qwen/qwen-2.5-vl-72b-instruct:free",

  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(анна|anna)(?![а-яёa-z])/i,
};