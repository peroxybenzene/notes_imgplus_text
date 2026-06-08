import os
import shutil
import subprocess
import sys

# Paths
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")

DIST_OUT_DIR = os.path.join(BACKEND_DIR, "dist")
BIN_OUT_DIR = os.path.join(BACKEND_DIR, "bin")

# 1. Path to local ffmpeg.exe (discovered earlier)
FFMPEG_SOURCE = r"C:\Users\sonu6\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-N-124716-g054dffd133-win64-gpl\bin\ffmpeg.exe"

def build():
    print("=== Step 1: Building Frontend statically ===")
    if not os.path.exists(FRONTEND_DIR):
        print(f"Error: Frontend directory not found at {FRONTEND_DIR}")
        sys.exit(1)
        
    print("Running npm run build inside frontend...")
    # Trigger production build to generate frontend/out
    result = subprocess.run("npm run build", shell=True, cwd=FRONTEND_DIR)
    if result.returncode != 0:
        print("Error: Frontend build failed.")
        sys.exit(1)
        
    frontend_out = os.path.join(FRONTEND_DIR, "out")
    if not os.path.exists(frontend_out):
        print(f"Error: Frontend build output not found at {frontend_out}")
        sys.exit(1)

    print("\n=== Step 2: Copying Frontend Build to Backend ===")
    if os.path.exists(DIST_OUT_DIR):
        print(f"Deleting existing backend dist folder: {DIST_OUT_DIR}")
        shutil.rmtree(DIST_OUT_DIR)
        
    print(f"Copying {frontend_out} to {DIST_OUT_DIR}")
    shutil.copytree(frontend_out, DIST_OUT_DIR)

    print("\n=== Step 3: Copying ffmpeg.exe to Backend Bin ===")
    os.makedirs(BIN_OUT_DIR, exist_ok=True)
    if not os.path.exists(FFMPEG_SOURCE):
        print(f"Error: ffmpeg.exe source not found at {FFMPEG_SOURCE}")
        sys.exit(1)
        
    ffmpeg_dest = os.path.join(BIN_OUT_DIR, "ffmpeg.exe")
    print(f"Copying {FFMPEG_SOURCE} to {ffmpeg_dest}")
    shutil.copy2(FFMPEG_SOURCE, ffmpeg_dest)

    print("\n=== Step 4: Compiling standalone EXE with PyInstaller ===")
    # Run PyInstaller
    # We bundle 'dist' folder and 'bin' folder (with ffmpeg.exe)
    pyinstaller_cmd = [
        os.path.join("venv", "Scripts", "pyinstaller"),
        "--onefile",
        "--name=notes_imgplus_text",
        "--add-data=dist;dist",
        "--add-data=bin/ffmpeg.exe;bin",
        "main.py"
    ]
    
    print(f"Running command: {' '.join(pyinstaller_cmd)} inside backend/")
    result = subprocess.run(" ".join(pyinstaller_cmd), shell=True, cwd=BACKEND_DIR)
    if result.returncode != 0:
        print("Error: PyInstaller compilation failed.")
        sys.exit(1)

    print("\n=== Step 5: Clean Up and Copy Output ===")
    # PyInstaller puts output in backend/dist/notes_imgplus_text.exe (since we ran inside backend)
    # Let's move it to root dist/ folder
    exe_src = os.path.join(BACKEND_DIR, "dist", "notes_imgplus_text.exe")
    if not os.path.exists(exe_src):
        # Fallback check under backend/dist/
        exe_src = os.path.join(BACKEND_DIR, "dist", "notes_imgplus_text.exe")
        
    final_dist_dir = os.path.join(ROOT_DIR, "dist")
    os.makedirs(final_dist_dir, exist_ok=True)
    exe_dest = os.path.join(final_dist_dir, "notes_imgplus_text.exe")
    
    # Check if build actually succeeded
    build_exe_path = os.path.join(BACKEND_DIR, "dist", "notes_imgplus_text.exe")
    if os.path.exists(build_exe_path):
        print(f"Copying final executable to: {exe_dest}")
        shutil.copy2(build_exe_path, exe_dest)
        print("\nSUCCESS! Standalone application created successfully.")
        print(f"Output File: {exe_dest}")
    else:
        # Check in backend/dist/notes_imgplus_text/
        print("Error: Executable not found in expected output path.")
        sys.exit(1)

if __name__ == "__main__":
    build()
