const axios = require('axios');
const config = require('../config');

class ScraperCore {
    constructor() {
        this.tavilyKey = config.tavilyKey || null;
    }

    cleanUrl(url) {
        try {
            const u = new URL(url);
            if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) return url;
            const params = u.searchParams;
            const junkParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                'fbclid', 'gclid', 'yclid', '_ga', 'mc_eid'
            ];
            junkParams.forEach(p => params.delete(p));
            return u.toString();
        } catch (e) {
            return url;
        }
    }

    // === МЕТОД 1: TAVILY ===
    async tryTavily(url) {
        if (!this.tavilyKey) return null;
        try {
            console.log(`[SCRAPER] 1. Tavily Extract...`);
            const response = await axios.post('https://api.tavily.com/extract', {
                urls: [url],
                include_images: false,
                extract_depth: "basic"
            }, {
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.tavilyKey}` 
                },
                timeout: 30000 
            });

            const data = response.data;
            if (data.results && data.results[0] && data.results[0].raw_content) {
                console.log(`[SCRAPER] ✅ Tavily Success.`);
                return { content: data.results[0].raw_content, method: 'tavily' };
            }
            
            // Если Tavily вернул ошибку внутри JSON (например, Failed to fetch)
            if (data.failed_results && data.failed_results.length > 0) {
                console.warn(`[SCRAPER] Tavily отказал: ${JSON.stringify(data.failed_results)}`);
            }
        } catch (e) {
            console.warn(`[SCRAPER] Tavily Error: ${e.message}`);
        }
        return null;
    }

    // === МЕТОД 2: JINA (ANONYMOUS PROXY) ===
    async tryJinaFree(url) {
        try {
            console.log(`[SCRAPER] 2. Активация Jina Proxy (Emergency Mode)...`);
            // Используем стандартный браузерный User-Agent, чтобы Jina не блокировала нас
            const response = await axios.get(`https://r.jina.ai/${url}`, {
                timeout: 25000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'X-Return-Format': 'markdown'
                }
            });

            if (response.data && response.data.length > 200 && !response.data.includes('Access Denied')) {
                console.log(`[SCRAPER] ✅ Jina Proxy Success.`);
                // Чистим мусор Jina
                let clean = response.data.split('## Related')[0];
                clean = clean.replace(/\[https:\/\/r\.jina\.ai\/.+\]/g, '');
                return { content: clean, method: 'jina_proxy' };
            }
        } catch (e) {
            console.warn(`[SCRAPER] Jina Proxy Error: ${e.message}`);
        }
        return null;
    }

    // === ОСНОВНОЙ МЕТОД ===
    async extract(rawUrl) {
        const url = this.cleanUrl(rawUrl);
        let result = { title: "", content: "", source: url, method: "none" };

        // ШАГ 1: Tavily
        const tavilyResult = await this.tryTavily(url);
        if (tavilyResult) {
            result.content = tavilyResult.content;
            result.method = tavilyResult.method;
            return result;
        }

        // ШАГ 2: Jina (Запаска)
        console.log(`[SCRAPER] ⚠️ Tavily не справился. Пробую запасной шлюз...`);
        const jinaResult = await this.tryJinaFree(url);
        if (jinaResult) {
            result.content = jinaResult.content;
            result.method = jinaResult.method;
            return result;
        }

        // ЕСЛИ ВСЕ УМЕРЛО
        throw new Error(`CRITICAL: Сайт недоступен ни через Tavily, ни через Proxy.`);
    }
}

module.exports = new ScraperCore();