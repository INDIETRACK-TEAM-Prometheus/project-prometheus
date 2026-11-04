# Contributing to Prometheus

Thanks for your interest. Prometheus is a small research prototype, so issues and focused pull requests are the best
way to help.

## Setup

Requirements: Windows 10/11, Node.js 20.17+ or 22.9+, Python 3.12, FFmpeg on `PATH`, and a Meta Model API key.

```powershell
npm ci
pwsh -NoProfile -File scripts\depth\setup.ps1
.asset-tmp\depth-runtime\venv312\Scripts\python.exe -m pip install transformers==4.57.1
$env:META_API_KEY = '<your key>'
$env:PROMETHEUS_COMPUTE_PROFILE = 'local'
npm start
```

`.env.example` lists every setting the server reads. The server takes them from the environment; it does not load a
`.env` file. Demo clips are not in the repository: see the README for how to export them from your own licensed
download.

## Tests

```sh
npm test
```

Tests use Node's built-in runner (`test/*.test.js`). They need no API key and no network: providers are injected. One
test calls Python 3 (the MPS CSV converter), and the HTTPS test runs only where PowerShell 7 is installed. Add or update
tests for any behaviour you change.

## Code style

- Match the surrounding code: its naming, comment density and idiom.
- JavaScript is plain ES modules; the UI uses React function components and hooks (`ui/`).
- Local model workers (`scripts/detect/`, `scripts/depth/`) are long-lived Python processes that speak JSON lines over
  stdio. Keep that protocol and validate every request.
- Keep the API key on the server. The browser talks only to the local server.

## Commits and pull requests

- Commit subject in the imperative ("Add place recall retries"), with a body that explains why when it is not obvious.
- One topic per pull request. Describe what changed, why, and how you tested it.
- Run `npm test` before opening the pull request.

## Data, keys and licenses

- **Never commit dataset media.** Aria Everyday Activities and HARMONIC files (videos, gaze tracks, point clouds,
  frames) must not be added to the repository; their licenses do not allow redistribution. `data/demo/` is ignored
  except for `playlist.json`.
- **Never commit API keys** or paste them in issues, pull requests or logs.
- Credit any new third-party model, dataset or library, with its version and license, in `ATTRIBUTIONS.md`. Only add
  dependencies whose licenses allow redistribution under this project's MIT license.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow
the [Code of Conduct](CODE_OF_CONDUCT.md).
