# Используем легкий образ Node.js (версия 20)
FROM node:20-alpine

# Рабочая директория внутри контейнера
WORKDIR /app

# Устанавливаем системные зависимости (для ffmpeg, если бот работает с голосовыми/видео)
# В README указана работа с голосовыми, поэтому ffmpeg нужен обязательно
# Было примерно так:
# RUN apk add --no-cache ffmpeg python3 make g++

# Стало (добавляем py3-pip и ставим yt-dlp):
RUN apk add --no-cache ffmpeg python3 py3-pip make g++ && \
    pip install yt-dlp --break-system-packages youtube-transcript-api

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем остальной код
COPY . .

# Создаем папку data, если её нет, для прав доступа
RUN mkdir -p data && chown -R node:node /app

# Переключаемся на пользователя node (безопасность)
USER node

# Команда запуска
CMD ["npm", "start"]
