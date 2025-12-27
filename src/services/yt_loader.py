import sys
import json
import os
import re
import glob
import time
import traceback

# Настройка кодировки
if sys.stderr.encoding != 'utf-8':
    try: sys.stderr.reconfigure(encoding='utf-8')
    except: pass
if sys.stdout.encoding != 'utf-8':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except: pass

# Импорты с уведомлением об ошибке
try:
    from yt_dlp import YoutubeDL
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    print(json.dumps({"error": "Missing libraries. Run: pip install yt-dlp youtube-transcript-api"}))
    sys.exit(1)

def log_debug(msg):
    timestamp = time.strftime("%H:%M:%S", time.localtime())
    print(f"[{timestamp} PY] {msg}", file=sys.stderr)
    sys.stderr.flush()

def clean_text(text):
    lines = text.split('\n')
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

def try_api_method(video_id):
    """
    Метод 1: Использование youtube_transcript_api.
    Этот метод работает через внутренний API субтитров и часто обходит блокировки,
    которые ловят yt-dlp (эмуляция браузера).
    """
    log_debug("Attempting Native Transcript API...")
    
    # Попытка 1: Современный метод list_transcripts
    try:
        if hasattr(YouTubeTranscriptApi, 'list_transcripts'):
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
            try:
                # Ищем созданные вручную (приоритет)
                t = transcript_list.find_transcript(['ru', 'en'])
            except:
                # Ищем авто-генерируемые
                t = transcript_list.find_generated_transcript(['ru', 'en'])
            
            data = t.fetch()
            text = " ".join([item['text'] for item in data])
            log_debug(f"SUCCESS API (list_transcripts): Got {len(text)} chars")
            return text
    except Exception as e:
        log_debug(f"API list_transcripts failed: {str(e)}")

    # Попытка 2: Классический метод get_transcript (работает на старых версиях либ)
    try:
        log_debug("Attempting legacy get_transcript...")
        # Пробуем получить сразу, приоритет RU, потом EN
        data = YouTubeTranscriptApi.get_transcript(video_id, languages=['ru', 'en'])
        text = " ".join([item['text'] for item in data])
        log_debug(f"SUCCESS API (get_transcript): Got {len(text)} chars")
        return text
    except Exception as e:
        log_debug(f"API get_transcript failed: {str(e)}")
        
    return None

def try_ytdlp_with_client(url, video_id, client_type):
    """Метод 2: yt-dlp с ротацией клиентов"""
    log_debug(f">>> Trying yt-dlp client: {client_type.upper()}...")
    
    ydl_opts = {
        'skip_download': True,
        'writeautomaticsub': True,
        'writesubtitles': True,
        'subtitleslangs': ['ru', 'en'],
        'subtitlesformat': 'vtt',
        'outtmpl': f'/tmp/yt_{video_id}_{client_type}',
        'quiet': True,
        'no_warnings': True,
        'verbose': False,
        'extractor_args': {
            'youtube': {
                'player_client': [client_type],
                'skip': ['dash', 'hls']
            }
        }
    }
    
    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            
            files = glob.glob(f"/tmp/yt_{video_id}_{client_type}*.vtt")
            if not files:
                log_debug(f"FAIL {client_type}: No files downloaded.")
                return None
            
            target = max(files, key=os.path.getsize)
            with open(target, 'r', encoding='utf-8') as f:
                content = f.read()
            
            for f in files:
                try: os.remove(f)
                except: pass
            
            return clean_text(content)

    except Exception as e:
        err_msg = str(e).split('\n')[0]
        log_debug(f"FAIL {client_type}: {err_msg[:100]}")
        return None

def main(url):
    video_id = get_video_id(url)
    if not video_id:
        print(json.dumps({"error": "Invalid YouTube URL"}))
        return

    log_debug(f"Processing ID: {video_id}")
    
    text = None
    method = "none"

    # === ИЗМЕНЕН ПОРЯДОК: СНАЧАЛА API, ПОТОМ YT-DLP ===
    
    # 1. Native API (Самый надежный при бане по IP)
    if not text:
        text = try_api_method(video_id)
        method = "transcript_api"

    # 2. iOS (yt-dlp)
    if not text:
        time.sleep(0.5)
        text = try_ytdlp_with_client(url, video_id, 'ios')
        method = "yt_dlp_ios"

    # 3. Android (yt-dlp)
    if not text:
        time.sleep(0.5)
        text = try_ytdlp_with_client(url, video_id, 'android')
        method = "yt_dlp_android"

    # 4. TV (yt-dlp)
    if not text:
        time.sleep(0.5)
        text = try_ytdlp_with_client(url, video_id, 'tv')
        method = "yt_dlp_tv"

    if text:
        print(json.dumps({
            "status": "ok",
            "title": f"YouTube Video {video_id}", 
            "text": text,
            "video_id": video_id,
            "method": method
        }, ensure_ascii=False))
    else:
        print(json.dumps({"error": "Failed to get subtitles (IP might be blocked by YouTube)"}))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main(sys.argv[1])
    else:
        print(json.dumps({"error": "No URL provided"}))