const OpenAI = require("openai");
const config = require('../config');
const prompts = require('../core/prompts');

class AiService {
  constructor() {
    this.keyIndex = 0;
    
    // Поддержка массива ключей
    this.keys = config.geminiKeys && config.geminiKeys.length > 0 
        ? config.geminiKeys 
        : [config.aiApiKey];

    if (this.keys.length === 0 || !this.keys[0]) console.error("CRITICAL: Нет API ключей в конфигурации!");
    
    this.client = null;
    this.initModel();
  }

  initModel() {
    const currentKey = this.keys[this.keyIndex];
    
    this.client = new OpenAI({
        apiKey: currentKey,
        baseURL: config.aiBaseUrl || "https://openrouter.ai/api/v1",
        defaultHeaders: {
            "HTTP-Referer": "https://telegram-bot.local",
            "X-Title": "Iron Character Bot"
        }
    });

    this.modelName = config.modelName || "deepseek/deepseek-chat";
  }

  rotateKey() {
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    console.log("AI WARNING: Лимит ключа! Переключаюсь на ключ " + (this.keyIndex + 1));
    this.initModel();
  }

  async executeWithRetry(apiCallFn) {
    for (let attempt = 0; attempt < this.keys.length + 1; attempt++) {
        try {
            return await apiCallFn();
        } catch (error) {
            console.error("AI ERROR Attempt " + attempt + ": " + error.message);
            
            const isQuotaError = error.status === 429 || error.message.includes('Quota') || error.message.includes('Rate limit');
            
            if (isQuotaError && this.keys.length > 1) {
                this.rotateKey();
                continue;
            } else if (attempt < 2) {
                await new Promise(res => setTimeout(res, 2000));
                continue;
            } else {
                throw error;
            }
        }
    }
    throw new Error("Не удалось получить ответ от нейросети.");
  }

  getCurrentTime() {
    return new Date().toLocaleString("ru-RU", {
      timeZone: "Europe/Berlin",
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  formatMessages(history, currentMessage, userInstruction, userProfile, systemText) {
      const messages = [];
      messages.push({ role: "system", content: systemText });

      const relevantHistory = history.slice(-20);
      relevantHistory.forEach(msg => {
          let role = "user";
          if (msg.role === "assistant" || msg.role === "model" || msg.sender === "Bot" || msg.role === "Анна") role = "assistant";
          
          if (msg.text && msg.text.trim()) {
              messages.push({ role: role, content: msg.text });
          }
      });

      let finalUserText = currentMessage.text;
      if (currentMessage.replyText) {
          finalUserText = "!!! ПОЛЬЗОВАТЕЛЬ ОТВЕТИЛ НА СООБЩЕНИЕ:\n" + currentMessage.replyText + "\n\n" + finalUserText;
      }
      if (userInstruction) {
          finalUserText += "\n\n!!! СПЕЦ-ИНСТРУКЦИЯ:\n" + userInstruction;
      }
      if (userProfile) {
          const score = userProfile.relationship || 50;
          let relationText = "";
          if (score <= 20) relationText = "СТАТУС: ВРАГ (" + score + "/100).";
          else if (score <= 40) relationText = "СТАТУС: ХОЛОД (" + score + "/100).";
          else if (score >= 80) relationText = "СТАТУС: БРАТАН (" + score + "/100).";

          const profileInfo = "\n--- ДОСЬЕ ---\nФакты: " + (userProfile.facts || "Нет") + "\n" + relationText + "\n-----------------\n";
          finalUserText = profileInfo + finalUserText;
      }
      
      finalUserText = "[Время: " + this.getCurrentTime() + "]\n" + finalUserText;

      return { messages, finalUserText };
  }
  
  async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
    const requestLogic = async () => {
        const systemPrompt = prompts.system() + (isSpontaneous ? "\n[РЕЖИМ: Спонтанное сообщение]" : "");
        const { messages, finalUserText } = this.formatMessages(history, currentMessage, userInstruction, userProfile, systemPrompt);

        const lastMessageContent = [];
        lastMessageContent.push({ type: "text", text: finalUserText });

        if (imageBuffer) {
            const base64Image = imageBuffer.toString("base64");
            lastMessageContent.push({
                type: "image_url",
                image_url: { url: "data:" + mimeType + ";base64," + base64Image }
            });
        }

        messages.push({ role: "user", content: lastMessageContent });

        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: messages,
            max_tokens: 2500,
            temperature: 0.9,
        });

        let text = response.choices[0].message.content;
        text = text.replace(/^<think>[\s\S]*?<\/think>/i, ''); 
        text = text.replace(/^thought[\s\S]*?\n\n/i, '');
        text = text.replace(/```json/g, '').replace(/```/g, '').trim(); 
        
        return text;
    };

    try { return await this.executeWithRetry(requestLogic); } catch (e) { throw e; }
  }

  async determineReaction(contextText) {
    const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
    const requestLogic = async () => {
        const promptText = prompts.reaction(contextText, allowed.join(" "));
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }],
            temperature: 0.5,
            max_tokens: 10
        });
        let text = response.choices[0].message.content.trim();
        const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
        if (match && allowed.includes(match[0])) return match[0];
        return null;
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  async analyzeUserImmediate(lastMessages, currentProfile) {
    const requestLogic = async () => {
        const promptText = prompts.analyzeImmediate(currentProfile, lastMessages);
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" },
            temperature: 0.7
        });
        let text = response.choices[0].message.content;
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  async analyzeBatch(messagesBatch, currentProfiles) {
    const requestLogic = async () => {
        const chatLog = messagesBatch.map(m => ("ID:" + m.userId + " " + m.name + ": " + m.text)).join('\n');
        const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => ("ID:" + uid + " -> " + p.realName + ", " + p.facts)).join('\n');
        const promptText = prompts.analyzeBatch(knownInfo, chatLog);
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        });
        let text = response.choices[0].message.content;
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  async generateProfileDescription(profileData, targetName) {
     const requestLogic = async () => {
        const promptText = prompts.profileDescription(targetName, profileData);
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }]
        });
        return response.choices[0].message.content;
     };
     try { return await this.executeWithRetry(requestLogic); } catch(e) { return "Не знаю такого."; }
  }

  async generateFlavorText(task, result) {
    const requestLogic = async () => {
        const promptText = prompts.flavor(task, result);
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }],
            temperature: 1.0 
        });
        return response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return "" + result; }
  }
  
  async shouldAnswer(lastMessages) {
    const requestLogic = async () => {
      const promptText = prompts.shouldAnswer(lastMessages);
      const response = await this.client.chat.completions.create({
          model: this.modelName,
          messages: [{ role: "user", content: promptText }],
          max_tokens: 10
      });
      return response.choices[0].message.content.toUpperCase().includes('YES');
  };
    try { return await this.executeWithRetry(requestLogic); } catch(e) { return false; }
  }

  async transcribeAudio(audioBuffer, userName = "Пользователь", mimeType = "audio/ogg") {
    // Большинство моделей OpenRouter text-only. Возвращаем null.
    return null; 
  }

  async parseReminder(userText, contextText = "") {
    const requestLogic = async () => {
        const now = this.getCurrentTime(); 
        const promptText = prompts.parseReminder(now, userText, contextText);
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" }
        });
        let text = response.choices[0].message.content;
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) text = text.substring(firstBrace, lastBrace + 1);
        return JSON.parse(text);
    };
    try { return await this.executeWithRetry(requestLogic); } catch (e) { return null; }
  }

  // === МЕТОД ДЛЯ YOUTUBE (ТЕПЕРЬ ВНУТРИ КЛАССА) ===
  async processYouTubeTranscript(title, transcript) {
    const prompt = prompts.youtubeEditor(title, transcript);
    
    // Используем тот же клиент, чтобы не создавать новый
    const requestLogic = async () => {
        const response = await this.client.chat.completions.create({
            model: this.modelName,
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content;
    };

    try { return await this.executeWithRetry(requestLogic); } catch (error) {
        console.error("AI YouTube Error:", error);
        throw new Error("Слишком длинное видео или ошибка API.");
    }
  }
}

module.exports = new AiService();