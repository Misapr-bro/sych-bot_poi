// services/reader.js
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

// Путь внутри контейнера (как в docker-compose.yml)
// Если локально на Windows - замени на свой путь, например 'C:\\Obsidian\\Inbox'
const basePath = process.env.OBSIDIAN_PATH || '/app/obsidian_inbox';

class ReaderService {
    constructor() {
        // Проверяем, существует ли папка
        if (!fs.existsSync(basePath)) {
            console.error(`[READER] Ошибка: Папка ${basePath} не найдена! Создаю пустую.`);
            fs.mkdirSync(basePath, { recursive: true });
        }
    }

    // Получить список всех .md файлов
    getAllFiles() {
        try {
            const files = fs.readdirSync(basePath);
            return files
                .filter(file => file.endsWith('.md'))
                .map(file => ({
                    name: file,
                    path: path.join(basePath, file)
                }));
        } catch (e) {
            console.error("[READER] Ошибка чтения директории:", e);
            return [];
        }
    }

    // Найти файл по нечеткому запросу
    async findFile(query) {
        const files = this.getAllFiles();
        
        if (files.length === 0) return null;

        const fuse = new Fuse(files, {
            keys: ['name'],
            threshold: 0.4, // Насколько точно должно совпадать (0.0 - идеально, 1.0 - любой мусор)
            includeScore: true
        });

        const result = fuse.search(query);

        if (result.length > 0) {
            // Возвращаем лучший результат
            return result[0].item;
        }
        return null;
    }

    // Прочитать содержимое
    readFileContent(filePath) {
        try {
            // Ограничиваем чтение (чтобы не забить память, если файл огромный)
            // Но для статей обычно ок.
            return fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            return null;
        }
    }
}

module.exports = new ReaderService();