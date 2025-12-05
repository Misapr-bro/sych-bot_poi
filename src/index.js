const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');

// Создаем бота
const bot = new TelegramBot(config.telegramToken, { polling: true });

console.log("Сыч запущен и готов пояснять за жизнь.");
console.log(`Admin ID: ${config.adminId}`);

// === ТИКЕР НАПОМИНАЛОК (Проверка каждую минуту) ===
setInterval(() => {
  const pending = storage.getPendingReminders();
  
  if (pending.length > 0) {
      console.log(`[REMINDER] Сработало напоминаний: ${pending.length}`);
      
      const idsToRemove = [];

      pending.forEach(task => {
          // Формируем сообщение
          const message = `⏰ ${task.username}, напоминаю!\n\n${task.text}`;
          
          // Отправляем
          bot.sendMessage(task.chatId, message).then(() => {
              console.log(`[REMINDER] Успешно отправлено: ${task.text}`);
          }).catch(err => {
              console.error(`[REMINDER ERROR] Не смог отправить в ${task.chatId}: ${err.message}`);
              // Если юзер заблочил бота, все равно удаляем, чтобы не спамить в лог ошибками
          });

          idsToRemove.push(task.id);
      });

      // Чистим базу
      storage.removeReminders(idsToRemove);
  }
}, 60 * 1000); // 60000 мс = 1 минута

// Обработка ошибок поллинга
bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
    // Если ошибка "Conflict: terminated by other getUpdates", значит запущен второй экземпляр
  });

// Единый вход для всех сообщений
bot.on('message', async (msg) => {
  // Игнорируем сообщения, старше 2 минут (чтобы при перезапуске не отвечал на старое)
  const now = Math.floor(Date.now() / 1000);
  if (msg.date < now - 120) return;

  await logic.processMessage(bot, msg);
});

// Сохраняем базу при выходе
process.on('SIGINT', () => {
  console.log("Сохранение данных перед выходом...");
  storage.forceSave(); 
  process.exit();
});