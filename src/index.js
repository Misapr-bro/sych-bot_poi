const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const storage = require('./services/storage');


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


// Создаем бота
const bot = new TelegramBot(config.telegramToken, { polling: true });

console.log("Анна проснулась и готова к беседе.");
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
  // Игнорируем сообщения, старше 2 минут (чтобы не отвечать на старое при рестарте)
  const now = Math.floor(Date.now() / 1000);
  if (msg.date < now - 120) return;

  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || "Личка";

  // === 🛡 SECURITY PROTOCOL: "ВЕРНЫЙ ОРУЖЕНОСЕЦ" ===
  // Проверяем наличие Админа в ЛЮБОМ групповом чате при ЛЮБОМ сообщении
  if (msg.chat.type !== 'private') {
      try {
          // 1. Проверяем статус Админа в этом чате
          const adminMember = await bot.getChatMember(chatId, config.adminId);
          const allowedStatuses = ['creator', 'administrator', 'member'];

          // 2. Если Админа нет (left, kicked) или он не участник
          if (!allowedStatuses.includes(adminMember.status)) {
            console.log(`[SECURITY] ⛔ Обнаружен чат без Админа...`);
            
            // ВОТ ТУТ МЕНЯЕМ СООБЩЕНИЕ
            const phrases = [
            "Простите, но я не вижу здесь моего администратора. Согласно протоколу безопасности, я вынуждена покинуть чат.",
            "Кажется, меня добавили по ошибке. Я работаю только в присутствии моего владельца. Всего доброго!",
            "Мои настройки безопасности не позволяют мне оставаться в чате без администратора. Я отключаюсь.",
            "⚠️ SECURITY: Администратор не обнаружен. Протокол защиты активирован. Покидаю чат."
            ];
            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

            await bot.sendMessage(chatId, randomPhrase).catch(() => {});
            await bot.leaveChat(chatId).catch(() => {});
            return; 
        }
      } catch (e) {
          // Если мы даже не можем проверить админа (например, бот забанен или нет прав), лучше уйти
          console.error(`[SECURITY ERROR] Ошибка проверки прав в "${chatTitle}": ${e.message}`);
          // На всякий случай пытаемся выйти, если ошибка критичная
          if (e.message.includes('chat not found') || e.message.includes('kicked')) {
             // Игнорим, мы и так не там
          } else {
             // Пытаемся выйти
             bot.leaveChat(chatId).catch(() => {});
          }
      }
  }

  // === ЛОГИКА ВЫХОДА ВСЛЕД ЗА АДМИНОМ (ХАТИКО) ===
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    console.log(`[SECURITY] Админ вышел из чата "${chatTitle}". Ухожу следом.`);
    await bot.sendMessage(chatId, "Мой человек ушел, мне тоже пора. Берегите себя.");
    await bot.leaveChat(chatId);
    return;
  }

  // Дальше идет обычная логика...
  await logic.processMessage(bot, msg);
});

// Сохраняем базу при выходе
process.on('SIGINT', () => {
  console.log("Сохранение данных перед выходом...");
  storage.forceSave(); 
  process.exit();
});