# WhatsApp Bot

## Requirements
- Node.js 20 or newer
- npm

## Run locally
```bash
npm install
npm start
```

On first run, pair WhatsApp using the terminal QR/pairing flow.
Keep `auth_info/`, `sessions/`, `.env`, and `data.json` private.
Never commit WhatsApp credentials or session files to GitHub.

## Hosting
Deploy as a persistent Node.js worker/service, not as a static website.
Configure persistent disk/storage for `auth_info/` and `data.json`.
Set any required environment variables in the hosting provider dashboard.
The current code calls Ollama at localhost:11434; that local service will
not exist on a cloud host unless separately deployed and configured.
