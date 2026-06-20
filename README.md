# n8n-nodes-mango-office

Community node for **Mango Office VPBX** (cloud telephony / Виртуальная АТС) for [n8n](https://n8n.io).

The signature `sha256(vpbx_api_key + json + vpbx_api_salt)` is computed **inside the node** from a credential — the salt never appears in workflow data, expressions, env vars, or exports.

## Credential — `Mango Office VPBX API`

| Field | Where to get it |
|-------|-----------------|
| API Key (`vpbx_api_key`) | ЛК → Интеграции → API коннектор → «Уникальный код вашей АТС» |
| API Salt (`vpbx_api_salt`) | ЛК → Интеграции → API коннектор → «Ключ для создания подписи» |
| Base URL | `https://app.mango-office.ru/vpbx` (default) |

API коннектор must be enabled; for recordings, «Записи разговоров: предоставлять ссылки» must be on.

## Node — `Mango Office`

- **Call → Get Many** — `stats/calls` (extended): async `request` + polls `result` until `complete`. Filters: date range (treated as UTC+3), Group IDs, User IDs, Direction (in/out/internal), Only Answered, Search String, Limit. Outputs one item per call (`entry_id`, `records`, numbers, direction, etc.).
- **Recording → Download** — by `recording_id` (`queries/recording/post`), returns the mp3 as binary.
- **Group → Get Many** — `/groups`.
- **User → Get Many** — `config/users/request`.

## Build & install (self-hosted)

```bash
npm install
npm run build
```

Install into n8n via one of:
- **Custom extensions dir:** copy this folder to `${N8N_CUSTOM_EXTENSIONS}` (or `~/.n8n/custom/`) on the n8n host and restart.
- **Community Nodes UI:** publish to npm, then n8n → Settings → Community Nodes → Install `n8n-nodes-mango-office`.

## Notes

- Stats period is capped at 1 month by the Mango API; results are async (poll-based).
- Recording temp links are one-shot; the node downloads the file directly.
- License: MIT.
