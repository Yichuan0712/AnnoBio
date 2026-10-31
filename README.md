<div align="center">

# AnnoBio

**Build, run, and improve LLM workflows for biomedical annotation, visually.**

[![Website][website-shield]][website-url]
[![User Guide][guide-shield]][guide-url]
<br>
[![Release][release-shield]][release-url]
[![Release Date][release-date-shield]][release-url]
[![Downloads][downloads-shield]][release-url]
[![License][license-shield]](LICENSE)

![AnnoBio Screenshot](images/screenshot.png)

</div>

[website-shield]: https://img.shields.io/badge/website-annobio.org-1f6feb
[website-url]: https://annobio.org
[guide-shield]: https://img.shields.io/badge/docs-user%20guide-1f6feb
[guide-url]: https://annobio.org/guide
[release-shield]: https://img.shields.io/github/v/release/Yichuan0712/AnnoBio?sort=semver
[release-date-shield]: https://img.shields.io/github/release-date/Yichuan0712/AnnoBio
[downloads-shield]: https://img.shields.io/github/downloads/Yichuan0712/AnnoBio/total
[release-url]: https://github.com/Yichuan0712/AnnoBio/releases
[license-shield]: https://img.shields.io/badge/license-MIT-blue

AnnoBio lets you classify documents, extract entities and fields, and curate literature into
structured records. You connect Datasets, Prompts, and processing steps on a canvas, run them,
compare the output with reference answers, and improve the Prompt from what went wrong. An Agent
can build and revise the workflow with you, and every change waits for your approval.

## Get Started

### Online

#### [AnnoBio Online](https://annobio.org)
- Nothing to install: create an account and open the workspace in your browser.
- Includes a free model, **AnnoBio AI**, with a daily token allowance. Connect your own
  OpenRouter account to go beyond it.

### Desktop

#### [Windows](https://github.com/Yichuan0712/AnnoBio/releases/latest/download/AnnoBio-Setup-x64.exe) · [macOS, Apple Silicon](https://github.com/Yichuan0712/AnnoBio/releases/latest/download/AnnoBio-arm64.dmg)
- Projects stay on your computer.
- Use your own API keys with any provider LiteLLM supports.
- Adds downloadable data snapshots and lets the Agent read files and folders you choose.

#### [Run from Source](#running-from-source)
- For development. Requires Python 3.12 and Node.js 22.

## Examples

See the [User Guide](https://annobio.org/guide) for a complete walkthrough, from an empty canvas
to an optimized Prompt, and the [Gallery](https://annobio.org/gallery) for pipelines other
researchers have published, with their Prompts, Datasets, and scores.

## Features

- A visual canvas: drag from a node's output to another node's input to connect them. Branch
  and merge pipelines, and run any step together with the upstream steps it needs.
- Import data from PubMed and 41 other online biomedical sources, including ClinicalTrials.gov,
  bioRxiv/medRxiv, ChEMBL, Europe PMC, OpenAlex, UniProt, PubChem, Ensembl, ClinVar, and PDB.
  Source identifiers and metadata stay with every record.
- Desktop only: 28 downloadable data snapshot groups, covering all data-lake files in the
  Biomni catalog.
- Prompts with typed output fields, input mappings, and evidence requirements. Every version
  is kept.
- Generate steps run a Prompt over a Dataset. Process steps run your own Python `process(df)`
  code.
- Evaluate output against reference answers with rules or code. String matching can resolve
  names to standard IDs through HGNC (human genes), PubChem (compounds), and ontologies (GO,
  ChEBI, MONDO), and you can inspect every mismatch.
- Optimize a Prompt from its evaluation failures, review each proposed change, and compare
  versions on data not used for the search. Methods:
  - **Thompson Prompt Search** (default): analyzes failures and proposes local instruction
    edits.
  - **GEPA**: reflective evolution of candidate instructions.
  - **MIPROv2**: instruction and few-shot example search.
  - **COPRO**: instruction-only search.
  - **BootstrapFewShotWithRandomSearch**: few-shot example selection.
  - **SIMBA**: self-reflective rules and few-shot examples.
  - **TextGrad**: textual-gradient instruction updates.
- Agent Assistant: describe a research task and it finds data, builds the pipeline, and
  explains results. It can also search the web. You approve each workflow change before it is
  applied.
- Run History for every step, and an evaluation history that keeps earlier attempts.
- Export a pipeline as a standalone, runnable Python project.
- Publish projects to the Gallery, or add a published project to your account and build on it.
- Prompts, Datasets, and evaluations that have produced results become read-only, so earlier
  results stay reproducible.

## Online or Desktop

| | Online | Desktop |
| --- | --- | --- |
| Install | None | Windows (x64), macOS (Apple Silicon) |
| Where projects live | Your account on annobio.org | Your computer |
| Models | Free AnnoBio AI allowance, or your OpenRouter account | Any LiteLLM provider with your own keys (OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Bedrock, OpenRouter, ...) |
| Data sources | PubMed + 41 online sources | PubMed + 41 online sources + 28 snapshot groups |
| Agent attachments and local folders | No | Yes |

## Shortcuts

| Keybind | Explanation |
| --- | --- |
| `Ctrl` + `Z` | Undo |
| `Ctrl` + `Shift` + `Z` / `Ctrl` + `Y` | Redo |
| `Delete` / `Backspace` | Delete the selected nodes |
| `Esc` | Clear the selection |

`Ctrl` can be replaced with `Cmd` on macOS. Shortcuts other than `Esc` are ignored while a text
field or code editor has focus.

# Installing

## Windows

Download [AnnoBio-Setup-x64.exe](https://github.com/Yichuan0712/AnnoBio/releases/latest/download/AnnoBio-Setup-x64.exe)
and run it. The installer is not code-signed yet, so Windows SmartScreen may warn you: click
**More info**, then **Run anyway**.

## macOS (Apple Silicon)

Download [AnnoBio-arm64.dmg](https://github.com/Yichuan0712/AnnoBio/releases/latest/download/AnnoBio-arm64.dmg),
open it, and drag AnnoBio into Applications. The app is not notarized by Apple yet, so the first
launch is blocked. Open **System Settings → Privacy & Security**, scroll down, and click
**Open Anyway** next to the AnnoBio message.

Intel Macs are not supported.

## Running from Source

1. Clone this repo.
2. Create the backend environment in `backend/.venv`. The desktop app looks for Python there
   in development.

   ```bash
   cd backend
   python -m venv .venv
   .venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
   ```

   TextGrad is optional and installed separately, without its heavy example-script
   dependencies:

   ```bash
   .venv/Scripts/python -m pip install --no-deps textgrad==0.1.8
   .venv/Scripts/python -m pip install platformdirs diskcache
   ```

3. Install and start the app. It starts the backend for you.

   ```bash
   cd app
   npm ci
   npm start
   ```

## Building the Installers

Installers are built by [GitHub Actions](.github/workflows/build-desktop.yml). Push a tag
starting with `v`:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The tag sets the app version. When both builds succeed, a release is published with
`AnnoBio-Setup-x64.exe` and `AnnoBio-arm64.dmg`. A tag with a suffix, such as `v1.2.0-beta.1`,
is published as a prerelease, and the `releases/latest/download` links above skip it.

To build locally, run `npm run dist` (Windows) or `npm run dist:mac` (macOS) in `app/`. The
installer bundles its own Python: on Windows, create it first with
`scripts/prepare-python-embed-windows.ps1`.

## Self-Hosting the Online Workspace

The online workspace is the Hub (`hub/`): sign-in, the public pages, and one backend container
per user, behind Caddy. See [docker-compose.yml](docker-compose.yml) for the build steps and every
setting. The main ones:

| Setting | Description |
| --- | --- |
| `PROMPT_STUDIO_SESSION_SECRET` | Required. A random secret for sign-in sessions. |
| `PROMPT_STUDIO_PUBLIC_BASE_URL` | The public address, such as `https://annobio.org`. Needed for OpenRouter sign-in. |
| `PROMPT_STUDIO_MAX_ACTIVE_CONTAINERS` | How many workspaces can run at once. `auto` (default) sizes it from the host's memory: (RAM − 2 GB) ÷ 1 GB. A number fixes it; `off` removes the limit. |
| `PROMPT_STUDIO_IDLE_TIMEOUT_SEC` | Stop a workspace after this many idle seconds. Default `1800`. |
| `ANNOBIO_HOSTED_DAILY_TOKENS` | Daily free-model allowance per account, reset at 00:00 UTC. Default `500000`. |

The free model is configured in `hub/hosted_model_config.py`. `MODEL_CREDENTIALS` names each
provider, model ID and Base URL, with its API key referenced by environment variable, never
committed. `ROLE_MODELS` picks a credential for Generate, Optimize and the Agent.

# Repository Layout

| Path | Contents |
| --- | --- |
| `app/` | Electron desktop app and the shared browser frontend |
| `backend/` | Python API used by both the desktop app and the online workspaces |
| `hub/` | Online workspace server: accounts, public pages, per-user containers |
| `python/` | `annobio-optimize`, a standalone library for the default optimization method |
| `scripts/` | Build helpers and the screenshot generator for the user guide and this README |

# Contact

For questions about AnnoBio data, methods, website feedback, or collaboration:

- Yichuan Zhang ([yichuan@usf.edu](mailto:yichuan@usf.edu))
- Duolin Wang ([duolinwang@usf.edu](mailto:duolinwang@usf.edu))

# License

AnnoBio is released under the [MIT License](LICENSE).
