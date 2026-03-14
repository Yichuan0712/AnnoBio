# Prompt Studio

A desktop application for prompt engineering and evaluation. Build prompts, run them against datasets with LLMs, score results against ground truth, and get AI-powered suggestions to improve your prompts.

## Features

- **Prompt nodes** – Create multi-section prompts with placeholders and structured output schemas
- **Dataset nodes** – Import CSV/Excel data or sample from larger datasets
- **Run nodes** – Execute prompts row-by-row with configurable LLM providers (OpenAI, Anthropic, Google, DeepSeek, Mistral, Bedrock)
- **Score nodes** – Compare run outputs with ground truth using flexible matching rules
- **Review nodes** – LLM analyzes score results and suggests prompt improvements
- **Resume** – Continue interrupted runs from where they left off
- **Cancel** – Stop running jobs from the UI or when closing the app

## Tech Stack

- **Frontend**: Electron + Vite, vanilla JS
- **Backend**: Python 3.x, FastAPI, Uvicorn
- **LLM integration**: LangChain (OpenAI, Anthropic, Google, Mistral, etc.)

## Prerequisites

- **Node.js** 16+ (for Electron and npm)
- **Python 3.10+** (for the backend)
- API keys for the LLM providers you want to use

## Setup

### 1. Backend (Python)

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### 2. Frontend (Electron)

```bash
cd app
npm install
```

## Running

From the **app** directory:

```bash
npm run start
```

This will:

1. Start the Python backend (FastAPI on port 8000)
2. Launch the Electron window with the workflow UI

The backend runs automatically when the app starts. Credentials and settings are stored in `backend/data/`.

## Building

To package the app for distribution:

```bash
cd app
npm run dist
```

Outputs a Windows executable in `out/`. The backend is bundled into `resources/backend/` with an embedded Python runtime.

## Project Structure

```
ElectronVuePython/
├── app/                    # Electron frontend
│   ├── src/
│   │   ├── main.js         # Main process (starts Python backend)
│   │   ├── renderer.js     # Renderer entry
│   │   ├── workflowCanvas.js
│   │   ├── runDetailModal.js
│   │   ├── promptDetailModal.js
│   │   └── ...
│   └── package.json
├── backend/                # Python API
│   ├── main.py             # FastAPI app, LLM run/review logic
│   ├── llm.py              # LangChain integration
│   ├── data/               # credentials.json, settings.json, run_jobs.json
│   └── requirements.txt
└── scripts/
    └── restart-backend.ps1 # Restart backend (Windows)
```

## API

The backend exposes a REST API on `http://localhost:8000`:

- `GET /health` – Health check
- `GET /api/credentials` – List credentials
- `POST /api/credentials` – Add/update credentials
- `GET /api/settings` – Get settings
- `PATCH /api/settings` – Update settings
- `POST /api/run` – Start a run (returns 202 with `run_id`)
- `GET /api/run/result/{run_id}` – Poll run status and results
- `POST /api/run/cancel/{run_id}` – Cancel a run
- `POST /api/review/*` – Prompt review endpoints

## Configuration

- **Concurrency**: 1–4 (default 1) for Run and Review
- **Max retries**: 0–5 (default 2) on LLM errors
- **Max tokens**: Configurable per Run and Review

Credentials (API keys) are stored in `backend/data/credentials.json` and are not committed to git.

## License

MIT
