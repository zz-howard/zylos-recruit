# Authentication

Two authentication methods are supported simultaneously.

## Cookie Session (Web UI)

Login via the web form at `/login` with the configured password.

- Cookie: `__Host-zylos_recruit_session`
- Absolute expiry: 24 hours
- Idle expiry: 60 minutes
- Password: scrypt-hashed, stored in `config.json`
- Brute-force protection: 5 failures per IP per minute → 10 min lockout; 30 global failures per minute cap

## API Token (Bearer)

For programmatic/agent access. Bypasses cookie auth for `/api/*` routes only.

### Token Format

`zr_` prefix + 48 hex characters (24 random bytes). Auto-generated on first start and written to `config.json`.

### Usage

```bash
TOKEN=$(jq -r '.auth.api_token' ~/zylos/components/recruit/config.json)
curl -H "Authorization: Bearer $TOKEN" https://host/recruit/api/candidates?company_id=1
```

### Security

- Validated with `crypto.timingSafeEqual` (constant-time comparison)
- Only applies to `/api/*` paths — cannot be used to access the web UI
- Token is stored in plaintext in `config.json` (file-system access = full access)

### Regenerating the Token

Delete `auth.api_token` from `config.json` and restart the service. A new token is generated automatically.
