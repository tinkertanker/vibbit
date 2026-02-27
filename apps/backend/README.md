# Vibbit managed backend

Teacher-friendly backend for Vibbit managed mode.

Students enter:

- backend URL
- class code

The backend keeps provider API keys server-side and proxies generation requests.

## Endpoints

- `GET /healthz`
- `GET /admin` (teacher/admin panel)
- `GET /admin/status` (admin JSON)
- `GET /vibbit/config`
- `POST /vibbit/connect`
- `POST /vibbit/generate`

## Admin panel

- Classroom mode: open `/admin?code=<CLASSCODE>`
- App-token mode: open `/admin?token=<SERVER_APP_TOKEN>`
- No-auth mode: open `/admin`

The panel shows effective runtime config, active session count, and quick links to diagnostic endpoints.

## Classroom connection flow

1. Teacher runs/deploys backend.
2. Backend has a class code (configured or auto-generated).
3. Students enter URL + class code in Vibbit managed mode.
4. Extension calls `POST /vibbit/connect` to get a short-lived session token.
5. Extension calls `POST /vibbit/generate` with that token.
6. Backend sends the request to configured provider/model with server-held keys.

## Request contract

### `POST /vibbit/connect`

Request body:

```json
{
  "classCode": "ABC123"
}
```

Success response:

```json
{
  "ok": true,
  "sessionToken": "vbt_...",
  "expiresAt": "2026-02-26T12:34:56.000Z",
  "authMode": "classroom",
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o-mini"
}
```

### `POST /vibbit/generate`

Request body:

```json
{
  "target": "microbit",
  "request": "Create a simple blinking LED pattern",
  "currentCode": "optional existing JS",
  "pageErrors": ["optional diagnostics"],
  "conversionDialog": {
    "title": "optional",
    "description": "optional"
  },
  "provider": "optional override",
  "model": "optional override"
}
```

Success response:

```json
{
  "code": "basic.showIcon(IconNames.Heart)",
  "feedback": ["At least one feedback line is always returned"]
}
```

Error response:

```json
{
  "error": "Human-readable error message"
}
```

## Local quick start (teacher laptop)

```bash
cd apps/backend
cp .env.example .env
# set at least one provider API key (for example VIBBIT_OPENAI_API_KEY)
npm start
```

By default:

- URL: `http://localhost:8787`
- Auth mode: `classroom`
- Class code: printed in server logs on start

Share that URL + code with students.

## Environment variables

Core:

- `PORT` (default `8787`)
- `VIBBIT_ALLOW_ORIGIN` (default `*`)
- `VIBBIT_REQUEST_TIMEOUT_MS` (default `60000`)
- `VIBBIT_EMPTY_RETRIES` (default `2`)
- `VIBBIT_VALIDATION_RETRIES` (default `2`)

Classroom auth:

- `VIBBIT_CLASSROOM_ENABLED` (default `true` unless `SERVER_APP_TOKEN` is set)
- `VIBBIT_CLASSROOM_CODE` (optional fixed code)
- `VIBBIT_CLASSROOM_CODE_AUTO` (default `true`)
- `VIBBIT_CLASSROOM_CODE_LENGTH` (default `5`; classroom codes are 5 uppercase letters)
- `VIBBIT_CLASSROOM_SEED` (optional deterministic seed)
- `VIBBIT_SESSION_TTL_MS` (default `28800000` = 8h)

Legacy app-token auth:

- `SERVER_APP_TOKEN` (if set, class-code mode is disabled)

Provider routing:

- `VIBBIT_ENABLED_PROVIDERS` (comma list; default `openai,gemini,openrouter`)
- `VIBBIT_PROVIDER` default provider
- `VIBBIT_MODEL` default fallback model
- `VIBBIT_OPENAI_ALLOWED_MODELS`, `VIBBIT_GEMINI_ALLOWED_MODELS`, `VIBBIT_OPENROUTER_ALLOWED_MODELS` (optional comma allow-lists)

Provider keys/models:

- `VIBBIT_API_KEY` (shared fallback)
- `VIBBIT_OPENAI_API_KEY`, `VIBBIT_OPENAI_MODEL`
- `VIBBIT_GEMINI_API_KEY`, `VIBBIT_GEMINI_MODEL`
- `VIBBIT_OPENROUTER_API_KEY`, `VIBBIT_OPENROUTER_MODEL`

## Deploy target (Railway)

Railway is the supported hosted deployment target for this backend.

### Deploy from GitHub (recommended)

1. Open [Railway New Project](https://railway.com/new) and choose **Deploy from GitHub repo**.
2. Select this repository.
3. Set the service root directory to `apps/backend`.
4. Add environment variables from `.env.example` (at minimum, one provider API key).
5. Generate a public domain for the service.
6. Share that HTTPS URL plus the classroom code with students.

### Deploy with CLI

```bash
cd apps/backend
npx @railway/cli login
npx @railway/cli link
npm run deploy:railway
```

## Notes

- For multi-replica deployments, keep session validation consistent across instances (stateless signed tokens or shared store).
- `GET /vibbit/config` is useful for quick diagnostics without exposing secrets.
