const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');

// === ЛОГИРОВАНИЕ ===
const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const t = now.toLocaleTimeString('ru-RU', { hour12: false });
  return `${d}.${m}.${y}-${t}`;
}

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);

// === ИНИЦИАЛИЗАЦИЯ БОТА (ПЕРЕНЕСЕНО ВВЕРХ) ===
const bot = new TelegramBot(config.telegramToken, { polling: true });

// Настройка командного меню
bot.setMyCommands([
  { command: 'start', description: 'Запустить Анну и получить справку' },
  { command: 'help', description: 'Показать список всех возможностей' },
  { command: 'save', description: 'Сохранить сообщение (или реплай) в Obsidian' },
  { command: 'mute', description: 'Включить/выключить режим тишины в чате' },
  { command: 'reset', description: 'Сбросить контекст текущего диалога' }
]);

console.log("Анна проснулась и готова к беседе.");
console.log(`Admin ID: ${config.adminId}`);

// [НОВОЕ] ПОДКЛЮЧАЕМ СЛУШАТЕЛЬ КНОПОК
logic.setupCallback(bot);

// === ОБРАБОТКА ОШИБОК (ТЕПЕРЬ ПОСЛЕ bot) ===
bot.on('polling_error', (error) => {
    // Игнорируем временные ошибки сети
    if (error.code !== 'EFATAL' && error.code !== 'ETIMEDOUT' && error.code !== 'ECONNRESET') {
        console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
    }
});

// === ТИКЕР НАПОМИНАЛОК ===
setInterval(() => {
  const pending = storage.getPendingReminders();
  
  if (pending.length > 0) {
      console.log(`[REMINDER] Сработало напоминаний: ${pending.length}`);
      
      const idsToRemove = [];

      pending.forEach(task => {
          const message = `⏰ ${task.username}, напоминаю!\n\n${task.text}`;
          
          bot.sendMessage(task.chatId, message).then(() => {
              console.log(`[REMINDER] Успешно отправлено: ${task.text}`);
          }).catch(err => {
              console.error(`[REMINDER ERROR] Не смог отправить в ${task.chatId}: ${err.message}`);
          });

          idsToRemove.push(task.id);
      });

      storage.removeReminders(idsToRemove);
  }
}, 60 * 1000); 

// === ОБРАБОТКА СООБЩЕНИЙ ===
bot.on('message', async (msg) => {
  const now = Math.floor(Date.now() / 1000);
  if (msg.date < now - 120) return;

  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || "Личка";

  if (msg.chat.type !== 'private') {
      try {
          const adminMember = await bot.getChatMember(chatId, config.adminId);
          const allowedStatuses = ['creator', 'administrator', 'member'];

          if (!allowedStatuses.includes(adminMember.status)) {
            console.log(`[SECURITY] ⛔ Чат без Админа: ${chatTitle}`);
            
            const phrases = [
                "Протокол безопасности: Я работаю только в присутствии владельца.",
                "⚠️ SECURITY: Администратор не обнаружен. Покидаю чат."
            ];
            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

            await bot.sendMessage(chatId, randomPhrase).catch(() => {});
            await bot.leaveChat(chatId).catch(() => {});
            return; 
        }
      } catch (e) {
          console.error(`[SECURITY ERROR] ${chatTitle}: ${e.message}`);
          if (!e.message.includes('chat not found')) {
             bot.leaveChat(chatId).catch(() => {});
          }
      }
  }

  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    console.log(`[SECURITY] Админ покинул "${chatTitle}". Ухожу.`);
    await bot.sendMessage(chatId, "Мой человек ушел, мне тоже пора.");
    await bot.leaveChat(chatId);
    return;
  }

  await logic.processMessage(bot, msg);
});

// Грейсфул шатдаун
process.on('SIGINT', () => {
  console.log("Сохранение данных...");
  storage.forceSave(); 
  process.exit();
});