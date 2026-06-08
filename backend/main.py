import os
import re
import uuid
import time
import logging
import threading
import subprocess
from typing import Dict, Any, Optional
from fastapi import FastAPI, BackgroundTasks, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, HttpUrl
import yt_dlp
import requests
from PIL import Image

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("backend")

# Refresh Windows environment PATH inside python process on startup
import winreg
def refresh_path_windows():
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment") as key:
            machine_path, _ = winreg.QueryValueEx(key, "Path")
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
            user_path, _ = winreg.QueryValueEx(key, "Path")
        combined_path = machine_path + ";" + user_path
        resolved_path = os.path.expandvars(combined_path)
        os.environ["PATH"] = resolved_path
        logger.info("Successfully refreshed Windows PATH inside python process.")
    except Exception as e:
        logger.error(f"Failed to refresh Windows PATH: {e}")

refresh_path_windows()

app = FastAPI(title="Multimodal AI Video Note-Taking API")

# Enable CORS for the Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify the frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SCREENSHOTS_DIR = os.path.join(STATIC_DIR, "screenshots")
TEMP_DIR = os.path.join(BASE_DIR, "temp")

os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

# Mount static folder for screenshots
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# In-memory job repository
jobs: Dict[str, Dict[str, Any]] = {}

class GenerateNotesRequest(BaseModel):
    url: str
    api_key: Optional[str] = None

class JobResponse(BaseModel):
    job_id: str
    status: str
    progress: str
    error: Optional[str] = None
    notes: Optional[str] = None

def timestamp_to_seconds(ts: str) -> int:
    parts = list(map(int, ts.split(':')))
    if len(parts) == 2:  # MM:SS
        return parts[0] * 60 + parts[1]
    elif len(parts) == 3:  # H:MM:SS
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0

def clean_filename(filename: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', filename)

def rest_upload_file(file_path: str, api_key: str, display_name: str) -> Dict[str, Any]:
    file_size = os.path.getsize(file_path)
    
    # 1. Initiate resumable upload session
    init_url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}"
    headers = {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(file_size),
        "X-Goog-Upload-Header-Content-Type": "video/mp4",
        "Content-Type": "application/json"
    }
    body = {
        "file": {
            "displayName": display_name
        }
    }
    
    logger.info(f"Initiating resumable upload for {file_path} (size: {file_size} bytes)...")
    res = requests.post(init_url, headers=headers, json=body)
    if res.status_code != 200:
        raise Exception(f"Failed to initiate file upload: {res.status_code} - {res.text}")
        
    upload_url = res.headers.get("x-goog-upload-url") or res.headers.get("Location")
    if not upload_url:
        raise Exception("Failed to get upload URL from response headers.")
        
    # 2. Upload file bytes
    logger.info("Uploading file bytes via REST...")
    upload_headers = {
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
    }
    with open(file_path, "rb") as f:
        file_bytes = f.read()
        
    res_upload = requests.post(upload_url, headers=upload_headers, data=file_bytes)
    if res_upload.status_code != 200:
        raise Exception(f"Failed to upload file bytes: {res_upload.status_code} - {res_upload.text}")
        
    upload_json = res_upload.json()
    file_info = upload_json.get("file")
    if not file_info:
        raise Exception(f"Invalid upload response: {upload_json}")
        
    return file_info

def rest_get_file_state(file_name: str, api_key: str) -> str:
    status_url = f"https://generativelanguage.googleapis.com/v1beta/{file_name}?key={api_key}"
    res = requests.get(status_url)
    if res.status_code != 200:
        raise Exception(f"Failed to check file state: {res.status_code} - {res.text}")
    return res.json().get("state", "UNKNOWN")

def rest_delete_file(file_name: str, api_key: str):
    delete_url = f"https://generativelanguage.googleapis.com/v1beta/{file_name}?key={api_key}"
    res = requests.delete(delete_url)
    if res.status_code not in [200, 204]:
        logger.warning(f"Failed to delete file {file_name}: {res.status_code} - {res.text}")

def rest_generate_content(file_uri: str, prompt: str, api_key: str) -> str:
    model_name = "gemini-3.5-flash"
    gen_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    
    headers = {
        "Content-Type": "application/json"
    }
    body = {
        "contents": [
            {
                "parts": [
                    {
                        "fileData": {
                            "mimeType": "video/mp4",
                            "fileUri": file_uri
                        }
                    },
                    {
                        "text": prompt
                    }
                ]
            }
        ]
    }
    
    logger.info(f"Sending generateContent request to model {model_name}...")
    res = requests.post(gen_url, headers=headers, json=body)
    if res.status_code != 200:
        raise Exception(f"Model generation failed with status code {res.status_code}: {res.text}")
        
    res_json = res.json()
    try:
        candidates = res_json.get("candidates", [])
        if not candidates:
            raise Exception(f"No candidates returned in response: {res_json}")
        text = candidates[0]["content"]["parts"][0]["text"]
        return text
    except KeyError as e:
        raise Exception(f"Unexpected response structure: {res_json}. Error: {e}")

def run_pipeline(job_id: str, url: str, api_key: str):
    jobs[job_id]["status"] = "processing"
    jobs[job_id]["progress"] = "Starting video download..."
    
    video_path = None
    uploaded_file_name = None
    
    try:
        # 1. Download Video using yt-dlp (limit to 480p)
        logger.info(f"[{job_id}] Downloading video: {url}")
        ydl_opts = {
            'format': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best',
            'outtmpl': os.path.join(TEMP_DIR, f"{job_id}_%(id)s.%(ext)s"),
            'noplaylist': True,
            'merge_output_format': 'mp4',
            'quiet': True,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            # Check what file was written (sometimes extension changes)
            base, _ = os.path.splitext(filename)
            mp4_filename = base + ".mp4"
            
            if os.path.exists(mp4_filename):
                video_path = mp4_filename
            elif os.path.exists(filename):
                video_path = filename
            else:
                # Find matching file in temp dir
                video_id = info.get('id')
                for f in os.listdir(TEMP_DIR):
                    if f.startswith(f"{job_id}_{video_id}") and f.endswith('.mp4'):
                        video_path = os.path.join(TEMP_DIR, f)
                        break
                if not video_path:
                    raise FileNotFoundError("Downloaded MP4 video file could not be found.")

        jobs[job_id]["progress"] = "Uploading video to Gemini..."
        logger.info(f"[{job_id}] Uploading video to Gemini File API: {video_path}")
        
        # 2. Upload video using REST API
        file_info = rest_upload_file(video_path, api_key, f"video_{job_id}")
        uploaded_file_name = file_info.get("name")
        file_uri = file_info.get("uri")
        state = file_info.get("state", "PROCESSING")
        
        logger.info(f"[{job_id}] Gemini File Name: {uploaded_file_name}, State: {state}")
        
        # Wait for Gemini processing
        jobs[job_id]["progress"] = "Gemini is analyzing the video footage..."
        while state == "PROCESSING":
            logger.info(f"[{job_id}] Waiting for video processing on Gemini...")
            time.sleep(5)
            state = rest_get_file_state(uploaded_file_name, api_key)
            
        if state != "ACTIVE":
            raise Exception(f"Gemini video processing failed with state: {state}")
            
        logger.info(f"[{job_id}] Video is active. Querying notes from model...")
        jobs[job_id]["progress"] = "Generating notes and identifying visual timestamps..."
        
        # 3. Call Gemini model using REST API
        prompt = (
            "You are an expert technical note-taking assistant. Watch this video and generate comprehensive, "
            "structured notes in Markdown. Focus on core concepts, architectures, configurations, math equations, "
            "code blocks, or step-by-step actions.\n\n"
            "Crucially, whenever the speaker refers to a visual on the screen (e.g. an architecture diagram, "
            "a block of code, a complex UI, or a whiteboard drawing), insert a tag formatted exactly as "
            "`[IMAGE_AT_MM:SS]` (or `[IMAGE_AT_H:MM:SS]` if the video is longer than an hour) right where that visual belongs in the notes.\n"
            "Do not insert tags for normal talking heads. Only insert tags for slides, code, whiteboard work, or UI. "
            "Provide rich descriptive context under each section so the notes are highly useful."
        )
        
        markdown_text = rest_generate_content(file_uri, prompt, api_key)
        logger.info(f"[{job_id}] Notes generated successfully. Length: {len(markdown_text)}")
        
        jobs[job_id]["progress"] = "Extracting screenshots at timestamps..."
        
        # 4. Extract timestamps
        # Matches [IMAGE_AT_MM:SS] or [IMAGE_AT_H:MM:SS] (with optional space/backticks)
        tag_pattern = r'\[IMAGE_AT_(\d{1,2}:\d{2}(?::\d{2})?)\]'
        matches = re.findall(tag_pattern, markdown_text)
        
        unique_matches = list(set(matches))
        logger.info(f"[{job_id}] Found {len(unique_matches)} unique visual timestamps: {unique_matches}")
        
        # 5. Extraction using FFmpeg & WebP compression
        screenshot_map = {}
        for ts in unique_matches:
            try:
                seconds = timestamp_to_seconds(ts)
                logger.info(f"[{job_id}] Extracting frame at {ts} ({seconds}s)...")
                
                temp_jpg = os.path.join(TEMP_DIR, f"{job_id}_{clean_filename(ts)}.jpg")
                webp_name = f"{job_id}_{clean_filename(ts)}.webp"
                webp_path = os.path.join(SCREENSHOTS_DIR, webp_name)
                
                # FFmpeg command
                # ffmpeg -y -ss HH:MM:SS -i video.mp4 -frames:v 1 -q:v 2 temp.jpg
                h = seconds // 3600
                m = (seconds % 3600) // 60
                s = seconds % 60
                time_str = f"{h:02d}:{m:02d}:{s:02d}"
                
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-ss", time_str,
                    "-i", video_path,
                    "-frames:v", "1",
                    "-q:v", "2",
                    temp_jpg
                ]
                
                result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if result.returncode != 0:
                    logger.error(f"[{job_id}] FFmpeg failed for {ts}: {result.stderr}")
                    continue
                
                # Compress to WebP
                if os.path.exists(temp_jpg):
                    with Image.open(temp_jpg) as img:
                        img.save(webp_path, "WEBP", quality=80)
                    os.remove(temp_jpg)
                    
                    # Store public URL mapping (relative to static)
                    screenshot_map[ts] = f"/static/screenshots/{webp_name}"
                    logger.info(f"[{job_id}] Extracted and compressed: {webp_path}")
            except Exception as e:
                logger.error(f"[{job_id}] Error extracting frame at {ts}: {e}")
                
        # 6. Replace tags with markdown image embeds
        final_notes = markdown_text
        for ts, webp_url in screenshot_map.items():
            # Search for variants like `[IMAGE_AT_MM:SS]` or `[IMAGE_AT_H:MM:SS]`
            # We replace exact string matches
            tag_str = f"[IMAGE_AT_{ts}]"
            embed_str = f"\n\n![Visual at {ts}]({webp_url})\n\n"
            final_notes = final_notes.replace(tag_str, embed_str)
            
            # Also handle if it's formatted inside backticks in the LLM output
            final_notes = final_notes.replace(f"`{tag_str}`", embed_str)
            
        jobs[job_id]["notes"] = final_notes
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = "Finished generating notes!"
        logger.info(f"[{job_id}] Job completed successfully.")
        
    except Exception as e:
        logger.exception(f"[{job_id}] Error running pipeline:")
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)
        jobs[job_id]["progress"] = "Failed."
        
    finally:
        # Clean up local downloaded video
        if video_path and os.path.exists(video_path):
            try:
                os.remove(video_path)
                logger.info(f"[{job_id}] Cleaned up local video file: {video_path}")
            except Exception as e:
                logger.error(f"[{job_id}] Failed to delete local video file: {e}")
                
        # Clean up Gemini File API upload
        if uploaded_file_name:
            try:
                rest_delete_file(uploaded_file_name, api_key)
                logger.info(f"[{job_id}] Cleaned up Gemini File API upload: {uploaded_file_name}")
            except Exception as e:
                logger.error(f"[{job_id}] Failed to delete Gemini File: {e}")


@app.post("/api/generate-notes", response_model=JobResponse)
def start_note_generation(
    req: GenerateNotesRequest, 
    x_gemini_api_key: Optional[str] = Header(None)
):
    # Determine which API key to use
    api_key = req.api_key or x_gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=400, 
            detail="Gemini API Key is required. Please provide it in the header, request body, or environment."
        )
        
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": "Queueing job...",
        "error": None,
        "notes": None
    }
    
    # Start thread
    thread = threading.Thread(target=run_pipeline, args=(job_id, req.url, api_key))
    thread.daemon = True
    thread.start()
    
    return JobResponse(
        job_id=job_id,
        status=jobs[job_id]["status"],
        progress=jobs[job_id]["progress"]
    )


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")
        
    job_data = jobs[job_id]
    return JobResponse(
        job_id=job_id,
        status=job_data["status"],
        progress=job_data["progress"],
        error=job_data["error"],
        notes=job_data["notes"]
    )
