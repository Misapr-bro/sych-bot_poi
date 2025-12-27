const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// === ВШИТЫЙ PYTHON СКРИПТ (CLEAN VERSION - DOCKER READY) ===
const PYTHON_SCRIPT_CONTENT = `
import sys
import json
import os
import re
import glob
import time

# --- ENV SETUP ---
if sys.stderr.encoding != 'utf-8':
    try: sys.stderr.reconfigure(encoding='utf-8')
    except: pass

def log_debug(msg):
    ts = time.strftime("%H:%M:%S")
    sys.stderr.write(f"[{ts} PY] {msg}\\n")
    sys.stderr.flush()

# --- IMPORTS ---
try:
    from yt_dlp import YoutubeDL
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError as e:
    print(json.dumps({"error": f"Critical: Libraries not installed in Docker. {e}"}))
    sys.exit(1)

COOKIE_FILE = '/app/cookies.txt'

def clean_text(text):
    lines = text.split('\\n')
    cleaned = []
    seen = set()
    for line in lines:
        l = line.strip()
        if not l or l == 'WEBVTT' or '-->' in l: continue
        if l.startswith('Kind:') or l.startswith('Language:') or l.startswith('<c>'): continue
        l = re.sub(r'<[^>]+>', '', l)
        l = re.sub(r'&nbsp;', ' ', l)
        if l in seen: continue
        seen.add(l)
        cleaned.append(l)
    return ' '.join(cleaned)

def get_video_id(url):
    match = re.search(r"(?:v=|/)([0-9A-Za-z_-]{11}).*", url)
    return match.group(1) if match else None

def inspect_cookies():
    return os.path.exists(COOKIE_FILE) and os.path.getsize(COOKIE_FILE) > 0

# --- METADATA FETCHING ---
def get_metadata(url, use_cookies):
    opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True
    }
    if use_cookies: opts['cookiefile'] = COOKIE_FILE

    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return {
                'title': info.get('title', 'Unknown Title'),
                'description': info.get('description', ''),
                'author': info.get('uploader', 'Unknown'),
                'duration': info.get('duration', 0)
            }
    except:
        return {'title': 'YouTube Video', 'description': '', 'author': '', 'duration': 0}

# --- SUBTITLE FETCHING ---
def try_api(video_id, use_cookies):
    cookies_path = COOKIE_FILE if use_cookies else None
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id, cookies=cookies_path)
        try: t = transcript_list.find_transcript(['ru', 'en'])
        except: t = transcript_list.find_generated_transcript(['ru', 'en'])
        data = t.fetch()
        return " ".join([item['text'] for item in data])
    except Exception: return None

def try_ytdlp(url, video_id, client_type, use_cookies):
    ydl_opts = {
        'skip_download': True,
        'writeautomaticsub': True,
        'writesubtitles': True,
        'subtitleslangs': ['ru', 'en'],
        'subtitlesformat': 'vtt', 
        'outtmpl': f'/tmp/yt_{video_id}_{client_type}',
        'quiet': True,
        'no_warnings': True,
    }
    if not use_cookies:
        ydl_opts['extractor_args'] = {'youtube': {'player_client': [client_type], 'skip': ['dash', 'hls']}}
    else:
        ydl_opts['cookiefile'] = COOKIE_FILE

    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            files = glob.glob(f"/tmp/yt_{video_id}_{client_type}*.vtt")
            if not files: return None
            target = max(files, key=os.path.getsize)
            with open(target, 'r', encoding='utf-8') as f: content = f.read()
            for f in files: 
                try: os.remove(f)
                except: pass
            return clean_text(content)
    except Exception: return None

def main(url):
    video_id = get_video_id(url)
    if not video_id:
        print(json.dumps({"error": "Invalid YouTube URL"}))
        return

    cookies_valid = inspect_cookies()
    text = None
    method = "none"
    used_cookies = False

    # 1. API No-Cookie
    if not text: text = try_api(video_id, False); method="api_nocook"
    # 2. YT-DLP Rotation
    if not text: text = try_ytdlp(url, video_id, 'android', False); method="android"
    if not text: time.sleep(0.5); text = try_ytdlp(url, video_id, 'tv', False); method="tv"
    if not text: time.sleep(0.5); text = try_ytdlp(url, video_id, 'ios', False); method="ios"
    # 3. Cookies
    if not text and cookies_valid:
        used_cookies = True
        if not text: text = try_api(video_id, True); method="api_cookie"
        if not text: text = try_ytdlp(url, video_id, 'web', True); method="web_cookie"

    if text:
        meta = get_metadata(url, used_cookies)
        print(json.dumps({
            "status": "ok",
            "video_id": video_id,
            "text": text,
            "method": method,
            "used_cookies": used_cookies,
            "title": meta['title'],
            "description": meta['description'],
            "author": meta['author'],
            "duration": meta['duration']
        }, ensure_ascii=False))
    else:
        print(json.dumps({"error": "Failed to get subtitles."}))

if __name__ == "__main__":
    if len(sys.argv) > 1: main(sys.argv[1])
    else: print(json.dumps({"error": "No URL"}))
`;

async function getTranscript(url) {
    return new Promise((resolve, reject) => {
        const scriptPath = '/tmp/yt_loader_final.py';
        try { fs.writeFileSync(scriptPath, PYTHON_SCRIPT_CONTENT); } catch (e) { return resolve(null); }
        
        console.log(`[YOUTUBE] Обработка: ${url}`);
        
        exec(`python3 "${scriptPath}" "${url}"`, { maxBuffer: 1024 * 1024 * 15 }, (error, stdout, stderr) => {
            if (stderr && stderr.trim().length > 0) console.log(`[PY LOG]: ${stderr.trim()}`);
            if (error) { console.error(`[EXEC ERROR] ${error.message}`); return resolve(null); }

            try {
                const lines = stdout.trim().split('\n');
                let jsonStr = "";
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (lines[i].trim().startsWith('{') && lines[i].trim().endsWith('}')) {
                        jsonStr = lines[i].trim();
                        break;
                    }
                }
                if (!jsonStr) return resolve(null);

                const data = JSON.parse(jsonStr);
                if (data.error) {
                    console.warn(`[YOUTUBE FAIL]: ${data.error}`);
                    return resolve(null);
                }

                console.log(`[YOUTUBE] Успех! "${data.title}" (Метод: ${data.method})`);
                
                resolve({
                    title: data.title,
                    text: data.text,
                    videoId: data.video_id,
                    usedCookies: data.used_cookies,
                    description: data.description,
                    author: data.author,
                    duration: data.duration
                });

            } catch (e) {
                console.error(`[PARSE ERROR]: ${e.message}`);
                resolve(null);
            }
        });
    });
}

module.exports = { getTranscript };