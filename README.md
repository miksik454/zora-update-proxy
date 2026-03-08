# Zora Update Proxy (Railway)

Proxy service for launcher updates from a private GitHub repository.

## What it does

- `GET /manifest` -> returns `manifest.json` from GitHub repo
- `GET /launcher-update` -> returns `launcher-update.json`
- `GET /file?path=gameDir/mods/ZoraClient.jar` -> returns raw file bytes

This keeps `GITHUB_TOKEN` on server only.

## Deploy on Railway

1. Create a new Railway project from this folder/repo.
2. Set environment variables:
   - `GITHUB_OWNER=miksik454`
   - `GITHUB_REPO=zora-client-files`
   - `GITHUB_BRANCH=main`
   - `GITHUB_TOKEN=<new_fine_grained_pat>`
3. Optional:
   - `GITHUB_BRANCHES=main,master`
   - `MANIFEST_PATHS=manifest.json,dist/manifest.json`
   - `LAUNCHER_UPDATE_PATHS=launcher-update.json,dist/launcher-update.json`
4. Deploy.
5. Check health:
   - `https://<your-app>.up.railway.app/health`

## Launcher integration

Set environment variable for launcher process:

- `ZORA_UPDATE_PROXY=https://<your-app>.up.railway.app`

After that launcher will prefer proxy endpoints for manifest and files.

## Security notes

- Use a **new** GitHub token (old leaked token must be revoked).
- Token scope should be minimal: read-only access to this repository content.
- Do not store token in launcher code.
