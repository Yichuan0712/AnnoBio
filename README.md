<div align="center">

# Prompt Studio

**Prompt engineering with you in the loop. Every iteration traceable.**

A desktop app for **prompt engineering** and **evaluation**. Design prompts, run them against datasets, score against ground truth, and refine with AI suggestions—no coding required.

![Screenshot](images/screenshot.png)

[Getting Started](#quick-start) · [Features](#features) · [Configuration](#configuration)

</div>

---

## Features

| Feature | Description |
|--------|-------------|
| **Prompt nodes** | Multi-section prompts with placeholders and structured output schemas |
| **Dataset nodes** | Import CSV/Excel or sample from larger datasets |
| **Run nodes** | Execute prompts row-by-row with OpenAI, Anthropic, Google, DeepSeek, Mistral, Bedrock |
| **Score nodes** | Compare outputs with ground truth using flexible matching rules |
| **Review nodes** | LLM analyzes results and suggests prompt improvements |
| **Resume** | Continue interrupted runs from checkpoint |
| **Cancel** | Stop running jobs anytime from the UI |

## Tech Stack

- **Frontend**: Electron + Vite (vanilla JS)
- **Backend**: Python 3.10+, FastAPI, Uvicorn
- **LLM**: LangChain (OpenAI, Anthropic, Google, DeepSeek, Mistral, Bedrock)

## Quick Start

**Prerequisites:** Node.js 16+, Python 3.10+, and API keys for your LLM providers.

```bash
# 1. Backend
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt

# 2. Frontend
cd ../app
npm install
npm run start
```

The app launches with the workflow UI. Credentials and settings live in `backend/data/`.

## Build

```bash
cd app
npm run dist
```

Output: Windows executable in `out/`. Backend is bundled with an embedded Python runtime.

## Project Structure

```
├── app/                 # Electron frontend
│   ├── src/
│   │   ├── workflowCanvas.js
│   │   ├── runDetailModal.js
│   │   ├── promptDetailModal.js
│   │   └── ...
│   └── package.json
├── backend/             # Python API
│   ├── main.py          # FastAPI, run/review logic
│   ├── llm.py           # LangChain integration
│   └── data/            # credentials, settings
├── images/              # Screenshots, provider logos
└── website/             # Landing page
```

## Configuration

| Setting | Range | Default |
|---------|-------|---------|
| Concurrency | 1–4 | 1 |
| Max retries | 0–5 | 2 |
| Max tokens | — | Configurable per Run/Review |

API keys go in `backend/data/credentials.json` (not committed).

## API

REST API on `http://localhost:8000`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET/POST | `/api/credentials` | Manage API keys |
| GET/PATCH | `/api/settings` | App settings |
| POST | `/api/run` | Start run (202 + `run_id`) |
| GET | `/api/run/result/{run_id}` | Poll status & results |
| POST | `/api/run/cancel/{run_id}` | Cancel run |
| POST | `/api/review/*` | Prompt review |

## License

MIT
