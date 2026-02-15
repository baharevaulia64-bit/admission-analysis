# Используем Node.js 20 (поддерживает ESM, type: module в package.json)
FROM node:20-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json для установки зависимостей
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем весь код проекта
COPY . .

# Экспонируем порт (из server.js — 3000)
EXPOSE 3000

# Команда запуска (npm start из package.json)
CMD ["npm", "start"]