"use client";

import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

const BACKEND_URL = "http://localhost:8000";

export default function Home() {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [viewMode, setViewMode] = useState("rendered"); // 'rendered' or 'raw'
  const [history, setHistory] = useState([]);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [copied, setCopied] = useState(false);

  const pollIntervalRef = useRef(null);

  // Load history and API key from localStorage on mount
  useEffect(() => {
    const savedHistory = localStorage.getItem("note_history");
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Error parsing history", e);
      }
    }

    const savedApiKey = localStorage.getItem("gemini_api_key");
    if (savedApiKey) {
      setApiKey(savedApiKey);
    }
  }, []);

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Poll job status
  const pollJobStatus = async (id) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/jobs/${id}`);
      if (!response.ok) {
        throw new Error("Failed to fetch job status");
      }
      const data = await response.json();
      setStatus(data.status);
      setProgress(data.progress);

      if (data.status === "completed") {
        setNotes(data.notes);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        // Add to history
        const newHistoryItem = {
          id: id,
          url: url,
          title: extractVideoTitle(url),
          notes: data.notes,
          timestamp: new Date().toLocaleString(),
        };

        const updatedHistory = [newHistoryItem, ...history.filter(h => h.url !== url)];
        setHistory(updatedHistory);
        localStorage.setItem("note_history", JSON.stringify(updatedHistory));
      } else if (data.status === "failed") {
        setError(data.error || "Generation pipeline failed.");
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
      setError("Error connecting to backend server.");
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  };

  const startPolling = (id) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => pollJobStatus(id), 3000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setError("");
    setNotes("");
    setStatus("pending");
    setProgress("Initializing job...");

    // Save API key to local storage if provided
    if (apiKey.trim()) {
      localStorage.setItem("gemini_api_key", apiKey.trim());
    } else {
      localStorage.removeItem("gemini_api_key");
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/generate-notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url.trim(),
          api_key: apiKey.trim() || null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Server error occurred");
      }

      const data = await response.json();
      setJobId(data.job_id);
      setStatus(data.status);
      setProgress(data.progress);
      startPolling(data.job_id);
    } catch (err) {
      console.error("Submit error:", err);
      setError(err.message || "Failed to start note generation.");
      setStatus("failed");
    }
  };

  const extractVideoTitle = (videoUrl) => {
    try {
      const urlObj = new URL(videoUrl);
      if (urlObj.hostname.includes("youtube.com")) {
        return urlObj.searchParams.get("v") || "YouTube Video";
      } else if (urlObj.hostname.includes("youtu.be")) {
        return urlObj.pathname.slice(1) || "YouTube Video";
      }
    } catch (e) {}
    return "YouTube Video";
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(notes);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadNotes = () => {
    let notesWithAbsoluteUrls = notes;
    notesWithAbsoluteUrls = notesWithAbsoluteUrls.replaceAll("/static/screenshots/", `${BACKEND_URL}/static/screenshots/`);

    const element = document.createElement("a");
    const file = new Blob([notesWithAbsoluteUrls], { type: "text/markdown" });
    element.href = URL.createObjectURL(file);
    
    // Clean filename
    const videoTitle = extractVideoTitle(url);
    const safeTitle = videoTitle.replace(/[^a-zA-Z0-9_-]/g, "_");
    element.download = `notes_${safeTitle}.md`;
    
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const downloadPDF = () => {
    if (viewMode !== "rendered") {
      setViewMode("rendered");
      setTimeout(() => {
        window.print();
      }, 150);
    } else {
      window.print();
    }
  };

  const handleSelectHistory = (item) => {
    setUrl(item.url);
    setNotes(item.notes);
    setStatus("completed");
    setError("");
  };

  const handleClearHistory = () => {
    setHistory([]);
    localStorage.removeItem("note_history");
  };

  const handleNewAnalysis = () => {
    setNotes("");
    setStatus("");
    setUrl("");
    setError("");
  };

  // Determine active steps for loader timeline
  const getStepStatus = (stepName) => {
    const steps = [
      { key: "download", text: "download" },
      { key: "upload", text: "upload" },
      { key: "analyze", text: "analyz" },
      { key: "generate", text: "generat" },
      { key: "extract", text: "extract" },
    ];

    const currentLower = (progress || "").toLowerCase();
    const stepIdx = steps.findIndex(s => currentLower.includes(s.text));

    if (status === "completed") return "completed";
    if (status === "failed") return "failed";

    const thisIdx = steps.findIndex(s => s.key === stepName);
    if (stepIdx === -1) {
      return thisIdx === 0 && status === "processing" ? "active" : "pending";
    }

    if (thisIdx < stepIdx) return "completed";
    if (thisIdx === stepIdx) return "active";
    return "pending";
  };

  return (
    <main className="min-h-screen relative bg-[#09090b] px-4 py-8 md:py-16 flex flex-col justify-between">
      {/* Background Decorative Blur */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-violet-600/10 blur-[120px] pointer-events-none glow-bg no-print" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[45%] h-[45%] rounded-full bg-pink-600/10 blur-[130px] pointer-events-none glow-bg no-print" />

      {/* Header Container */}
      <div className="max-w-6xl w-full mx-auto flex-grow">
        <header className="flex items-center justify-between mb-12 border-b border-white/5 pb-6 no-print">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-violet-600 to-pink-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
                Antigravity Notes
              </h1>
              <p className="text-xs text-zinc-500 font-medium">Multimodal AI Video Note-Taker</p>
            </div>
          </div>
          <div className="text-xs text-zinc-500 bg-white/5 border border-white/5 px-3 py-1.5 rounded-full font-medium">
            Local Server: <span className="text-emerald-400 font-semibold">Online</span>
          </div>
        </header>

        {/* Input / Dashboard View */}
        {!status && (
          <div className="grid md:grid-cols-3 gap-8 items-start">
            {/* Input Card */}
            <div className="md:col-span-2 glass-card rounded-2xl p-6 md:p-8 space-y-6">
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-white tracking-tight">Generate Technical Notes</h2>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  Paste a YouTube video link. Our model will download, analyze the visual slides, screenshots, or whiteboard derivations, and output beautifully structured notes containing screenshots.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="url" className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    YouTube Video URL
                  </label>
                  <input
                    id="url"
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full glass-input px-4 py-3.5 rounded-xl text-sm font-medium focus:ring-2 focus:ring-violet-500"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor="api-key" className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex justify-between">
                    <span>Gemini API Key</span>
                    <span className="text-[10px] text-zinc-500 lowercase">Optional if set on server</span>
                  </label>
                  <input
                    id="api-key"
                    type="password"
                    placeholder="Enter AI API Key to store in browser..."
                    className="w-full glass-input px-4 py-3.5 rounded-xl text-sm font-mono focus:ring-2 focus:ring-violet-500"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="p-4 bg-red-950/30 border border-red-500/20 text-red-400 rounded-xl text-xs font-medium">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-4 px-6 rounded-xl bg-gradient-to-r from-violet-600 to-pink-500 text-white text-sm font-bold shadow-lg shadow-violet-600/20 hover:shadow-violet-600/35 transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                >
                  Start Analyzing Video
                </button>
              </form>
            </div>

            {/* History Card */}
            <div className="glass-card rounded-2xl p-6 space-y-4 max-h-[450px] overflow-y-auto">
              <div className="flex items-center justify-between border-b border-white/5 pb-3">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Recent Notes</h3>
                {history.length > 0 && (
                  <button
                    onClick={handleClearHistory}
                    className="text-[10px] font-bold text-zinc-500 hover:text-red-400 transition-colors uppercase tracking-wider cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="py-8 text-center text-zinc-500 text-xs font-medium space-y-2">
                  <svg className="w-8 h-8 mx-auto text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                  <p>No analyzed history yet.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {history.map((item, index) => (
                    <div
                      key={item.id || index}
                      onClick={() => handleSelectHistory(item)}
                      className="p-3 rounded-xl border border-white/5 hover:border-violet-500/30 bg-white/2 hover:bg-white/4 cursor-pointer transition-all duration-200"
                    >
                      <h4 className="text-xs font-bold text-zinc-200 truncate">{item.title}</h4>
                      <p className="text-[10px] text-zinc-500 mt-1 truncate">{item.url}</p>
                      <div className="text-[9px] text-zinc-600 mt-2 font-medium flex items-center justify-between">
                        <span>{item.timestamp}</span>
                        <span className="text-violet-400">View notes →</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Loading / Processing View */}
        {(status === "pending" || status === "processing") && (
          <div className="max-w-xl mx-auto glass-card rounded-2xl p-8 space-y-8 text-center">
            <div className="relative w-16 h-16 mx-auto">
              <div className="absolute inset-0 rounded-full border-2 border-violet-500/20" />
              <div className="absolute inset-0 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-bold text-white">Analyzing Video Footage</h3>
              <p className="text-zinc-400 text-xs font-mono bg-zinc-950/50 py-1.5 px-3 rounded-lg border border-white/5 inline-block">
                {progress}
              </p>
            </div>

            {/* Timeline Progress Tracker */}
            <div className="max-w-sm mx-auto text-left space-y-4 pt-4 border-t border-white/5">
              {[
                { key: "download", text: "Downloading YouTube video source" },
                { key: "upload", text: "Transferring file to Gemini VLM" },
                { key: "analyze", text: "Model watching & analyzing footage" },
                { key: "generate", text: "Drafting notes & placing image anchors" },
                { key: "extract", text: "Slicing keyframes with FFmpeg" }
              ].map((step, idx) => {
                const stepStatus = getStepStatus(step.key);
                return (
                  <div key={idx} className="flex items-center gap-3">
                    <div className="flex-shrink-0">
                      {stepStatus === "completed" && (
                        <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center">
                          <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                      {stepStatus === "active" && (
                        <div className="w-5 h-5 rounded-full bg-violet-500/20 border border-violet-500 flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-violet-400 animate-ping" />
                        </div>
                      )}
                      {stepStatus === "pending" && (
                        <div className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700" />
                      )}
                    </div>
                    <span className={`text-xs font-medium ${stepStatus === "active" ? "text-violet-400 font-bold" : stepStatus === "completed" ? "text-zinc-400" : "text-zinc-600"}`}>
                      {step.text}
                    </span>
                  </div>
                );
              })}
            </div>

          </div>
        )}

        {/* Failed View */}
        {status === "failed" && (
          <div className="max-w-xl mx-auto glass-card rounded-2xl p-8 space-y-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto text-red-400">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-bold text-white">Analysis Failed</h3>
              <p className="text-zinc-400 text-xs leading-relaxed max-h-48 overflow-y-auto bg-zinc-950/45 p-4 rounded-xl border border-white/5 font-mono text-left">
                {error}
              </p>
            </div>
            <button
              onClick={handleNewAnalysis}
              className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Go Back to Dashboard
            </button>
          </div>
        )}

        {/* Notes Output Workspace */}
        {status === "completed" && notes && (
          <div className="space-y-6">
            {/* Toolbar */}
            <div className="glass-card rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 no-print">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-violet-400 uppercase tracking-widest">Active Notes</span>
                <h3 className="text-sm font-bold text-white truncate max-w-md">{url}</h3>
              </div>

              <div className="flex items-center gap-2">
                {/* Mode Toggles */}
                <div className="bg-zinc-950/80 border border-white/5 p-1 rounded-lg flex items-center">
                  <button
                    onClick={() => setViewMode("rendered")}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer ${viewMode === "rendered" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
                  >
                    Rendered View
                  </button>
                  <button
                    onClick={() => setViewMode("raw")}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer ${viewMode === "raw" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
                  >
                    Raw Markdown
                  </button>
                </div>

                <button
                  onClick={copyToClipboard}
                  className="px-3 py-2 border border-white/5 bg-white/3 hover:bg-white/5 hover:border-white/10 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  {copied ? "Copied!" : "Copy"}
                </button>

                <button
                  onClick={downloadNotes}
                  className="px-3 py-2 border border-white/5 bg-white/3 hover:bg-white/5 hover:border-white/10 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer text-zinc-200"
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download .md
                </button>

                <button
                  onClick={downloadPDF}
                  className="px-3 py-2 border border-white/5 bg-white/3 hover:bg-white/5 hover:border-white/10 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer text-zinc-200"
                >
                  <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  Download PDF
                </button>

                <button
                  onClick={handleNewAnalysis}
                  className="px-3 py-2 bg-gradient-to-r from-violet-600 to-pink-500 rounded-lg text-xs font-bold text-white hover:opacity-90 shadow-md transition-all cursor-pointer"
                >
                  New Link
                </button>
              </div>
            </div>

            {/* Note Area */}
            <div className="glass-card print-container rounded-2xl p-6 md:p-8 min-h-[500px]">
              {viewMode === "rendered" ? (
                <article className="prose max-w-none">
                  <ReactMarkdown
                    components={{
                      img: ({ node, src, ...props }) => {
                        const fullSrc = src.startsWith("/") ? `${BACKEND_URL}${src}` : src;
                        return (
                          <span className="block my-6 text-center">
                            <img
                              src={fullSrc}
                              className="rounded-xl border border-white/5 shadow-2xl inline-block max-w-full h-auto cursor-pointer transition-all duration-300 hover:scale-[1.01] hover:border-violet-500/30"
                              onClick={() => setLightboxImage(fullSrc)}
                              alt={props.alt || "Visual Note screenshot"}
                            />
                            <span className="block text-[10px] text-zinc-500 mt-2 font-medium italic">
                              {props.alt || "Frame captured from video"} (Click to enlarge)
                            </span>
                          </span>
                        );
                      }
                    }}
                  >
                    {notes}
                  </ReactMarkdown>
                </article>
              ) : (
                <div className="relative">
                  <textarea
                    readOnly
                    value={notes}
                    className="w-full min-h-[500px] bg-zinc-950/50 font-mono text-xs text-zinc-350 p-6 rounded-xl border border-white/5 focus:outline-none resize-y"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="max-w-6xl w-full mx-auto mt-12 pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between text-xs text-zinc-650 no-print">
        <p>© 2026 Antigravity Systems. All rights reserved.</p>
        <p className="flex items-center gap-1.5">
          Built for pair programming locally
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        </p>
      </footer>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 bg-[#000000ee] backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setLightboxImage(null)}
        >
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 p-2 bg-white/5 hover:bg-white/10 border border-white/5 rounded-full text-white cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <img
            src={lightboxImage}
            alt="Enlarged Visual Note"
            className="max-w-full max-h-[90vh] object-contain rounded-lg border border-white/10 shadow-2xl cursor-default"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </main>
  );
}
