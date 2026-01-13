const OpenAI = require("openai");
const config = require('../config');
const prompts = require('../core/prompts');

class AiService {
    // ==========================================
    // БЛОК 1: ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ КЛЮЧАМИ
    // ==========================================
    constructor() {
        this.keyIndex = 0;
        this.keys = config.geminiKeys && config.geminiKeys.length > 0 ? config.geminiKeys : [config.aiApiKey];
        
        if (this.keys.length === 0 || !this.keys[0]) {
            console.error("CRITICAL: Ключи API не найдены!");
        }

        this.client = null;
        // Актуальные модели 2026 года
        this.fallbackModel = "google/gemini-2.5-flash-lite"; 
        this.initModel();
    }

    /**
     * Подблок: Настройка клиента.
     * Здесь мы задаем базовую модель и параметры подключения к OpenRouter.
     */
    initModel() {
        const currentKey = this.keys[this.keyIndex];
        this.client = new OpenAI({
            apiKey: currentKey,
            baseURL: config.aiBaseUrl || "https://openrouter.ai/api/v1",
            defaultHeaders: {
                "HTTP-Referer": "https://anna-secretary.local",
                "X-Title": "Anna AI Secretary"
            }
        });
        // Если в конфиге старая модель, подстраховываемся
        this.modelName = config.modelName || this.fallbackModel;
    }

    /**
     * Подблок: Ротация ключей и попытки.
     */
    async executeWithRetry(apiCallFn) {
        for (let attempt = 0; attempt < this.keys.length + 1; attempt++) {
            try {
                return await apiCallFn();
            } catch (error) {
                console.error(`[AI_ERROR] Попытка ${attempt}: ${error.message}`);
                
                // Если модель не найдена (ошибка 400), пробуем переключиться на стабильный Flash Lite
                if (error.status === 400 && this.modelName !== this.fallbackModel) {
                    console.log(`[AI_FIX] Модель ${this.modelName} невалидна. Откат на ${this.fallbackModel}`);
                    this.modelName = this.fallbackModel;
                    return await apiCallFn();
                }

                const isQuota = error.status === 429 || error.message.includes('Quota');
                if (isQuota && this.keys.length > 1) {
                    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
                    this.initModel();
                    continue;
                }
                
                async executeWithRetry(apiCallFn) {
    for (let attempt = 0; attempt < this.keys.length + 1; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            console.error(`[AI_ERROR] Попытка ${attempt}: ${error.message}`);
            
            // Если это 404 или 400 — пробрасываем детали в месседж
            if (error.status === 404 || error.status === 400) {
                throw new Error(`⚠️ Ошибка модели (${this.modelName}): ${error.message}`);
            }
                
                if (attempt < 2) {
                    await new Promise(res => setTimeout(res, 2000));
                    continue;
                }
                throw error;
            }
        }
        throw new Error("Анна временно недоступна (API Error).");
    }

    // ==========================================
    // БЛОК 2: ФОРМАТИРОВАНИЕ КОНТЕКСТА
    // ==========================================

    getCurrentTime() {
        return new Date().toLocaleString("ru-RU", {
            timeZone: "Europe/Berlin",
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    /**
     * Подблок: Сборка промпта.
     * Принудительно внедряем инструкцию о русском языке.
     */
    formatMessages(history, currentMessage, userInstruction, userProfile, systemText) {
        const messages = [];
        
        // ЖЕСТКАЯ УСТАНОВКА: Всегда на русском
        const languageForce = "\n\n!!! ВАЖНО: Всегда отвечай СТРОГО на русском языке, независимо от языка входящих данных.";
        messages.push({ role: "system", content: systemText + languageForce });

        // История (лимит 20 сообщений для экономии токенов)
        history.slice(-20).forEach(msg => {
            let role = (msg.role === "assistant" || msg.role === "Анна") ? "assistant" : "user";
            if (msg.text) messages.push({ role, content: msg.text });
        });

        let userText = currentMessage.text;
        
        // Интеграция досье и статуса отношений
        if (userProfile) {
            const score = userProfile.relationship || 50;
            const status = score >= 80 ? "БРАТАН" : (score <= 30 ? "ХОЛОД" : "НЕЙТРАЛ");
            const profileInfo = `--- ДОСЬЕ: ${status} (${score}/100) ---\nФакты: ${userProfile.facts || "нет"}\n---\n`;
            userText = profileInfo + userText;
        }

        if (userInstruction) userText += `\n\n[СПЕЦ-ИНСТРУКЦИЯ]: ${userInstruction}`;
        
        const finalContent = `[Время: ${this.getCurrentTime()}]\n${userText}`;
        return { messages, finalContent };
    }

    // ==========================================
    // БЛОК 3: ОСНОВНЫЕ МЕТОДЫ AI
    // ==========================================

    async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null) {
        const requestLogic = async () => {
            const systemPrompt = prompts.system();
            const { messages, finalContent } = this.formatMessages(history, currentMessage, userInstruction, userProfile, systemPrompt);

            const lastMessage = [{ type: "text", text: finalContent }];

            if (imageBuffer) {
                const b64 = imageBuffer.toString("base64");
                lastMessage.push({
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${b64}` }
                });
            }

            messages.push({ role: "user", content: lastMessage });

            const response = await this.client.chat.completions.create({
                model: this.modelName,
                messages: messages,
                max_tokens: 2500,
                temperature: 0.8,
            });

            let text = response.choices[0].message.content;
            // Очистка от технического мусора
            return text.replace(/^<think>[\s\S]*?<\/think>/i, '').trim();
        };

        return await this.executeWithRetry(requestLogic);
    }

    /**
     * Подблок: Транскрибация аудио.
     * Gemini 2.5 Flash Lite отлично справляется с аудио напрямую.
     */
    async transcribeAudio(audioBuffer, userName = "User", mimeType = "audio/ogg") {
        // Если провайдер поддерживает аудио в чате, можно слать как картинку (base64)
        // Для OpenRouter пока оставляем заглушку или используем Whisper, если доступен.
        return null; 
    }

    // ==========================================
    // БЛОК 4: АНАЛИТИКА И ДОПОЛНИТЕЛЬНО
    // ==========================================

    async analyzeUserImmediate(lastMessages, currentProfile) {
        const requestLogic = async () => {
            const prompt = prompts.analyzeImmediate(currentProfile, lastMessages);
            const response = await this.client.chat.completions.create({
                model: this.fallbackModel, // Используем стабильную модель для аналитики
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            });
            return JSON.parse(response.choices[0].message.content);
        };
        try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
    }
}

module.exports = new AiService();