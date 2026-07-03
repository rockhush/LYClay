## LYClaw Tool Notes

### uv (Python)

- `uv` is bundled with LYClaw and on PATH. Do NOT use bare `python` or `pip`.
- Run scripts: `uv run python <script>` | Install packages: `uv pip install <package>`

### Browser

- `browser` tool provides full automation (scraping, form filling, testing) via an isolated managed browser.
- Flow: `action="start"` → `action="snapshot"` (see page + get element refs like `e12`) → `action="act"` (click/type using refs).
- Open new tabs: `action="open"` with `targetUrl`.
- To just open a URL for the user to view, use `shell:openExternal` instead.

### Using installed skills

Installed skills live on disk under `~/.openclaw/skills/<slug>/` (one folder per skill).

When the user **@mentions**, selects, or asks to **use** a skill:

1. **Do not** run `lyclaw-marketplace install` or `clawhub install` if that skill folder already exists.
2. Use `read` on `~/.openclaw/skills/<slug>/SKILL.md` first, then follow the skill's own docs/scripts.
3. Resolve `<slug>` from the skills directory listing when the display name differs (folder name wins over UI label).
4. Run marketplace install **only** when the folder/`SKILL.md` is missing or the user explicitly asks to download/install/update from 技能广场.

### Skill Marketplace (技能广场) — CLI (install new skills only)

Use **`lyclaw-marketplace`** via `exec`. It calls the same Host API as **Skills → 技能广场**; marketplace login/session is handled inside Lyclaw Main (not in chat). **LYClaw must be running** so `~/.openclaw/.lyclaw/host-api-bridge.json` exists.

Resolve the script path (dev vs packaged app):

```bash
node "<lyclaw-app>/scripts/lyclaw-marketplace-cli.mjs" search --query "报销 excel"
node "<lyclaw-app>/scripts/lyclaw-marketplace-cli.mjs" install 123
```

If `lyclaw-marketplace` is on PATH (pnpm/npm bin), you may call it directly:

```bash
lyclaw-marketplace search --query "报销 excel"
lyclaw-marketplace install 123 --name "Optional display name"
```

#### `search`

```bash
lyclaw-marketplace search [--query text] [--category cat] [--sort -download_count]
```

- `--query`: keywords from the user's request
- `--category` (optional): `finance`, `rnd`, `hr`, `manufacture`, `procurement`, `business`, `legal`, `office`, `it`, `logistics`, `other`
- `--sort` (optional): `-download_count` (default hottest), `-update_time`, etc.

JSON output includes `results[]` with `id`, `name`, `description`, `version`, `author`. **Install using numeric `id`.**

#### `install`

```bash
lyclaw-marketplace install <marketplace-id> [--version x.y.z] [--name "Display Name"]
```

Downloads, extracts, and enables the skill. **Only use when the skill is not already under `~/.openclaw/skills/`.** After success, briefly tell the user what was installed and that they can use the skill in the next turn (Gateway may reload skills).

#### Fallback — public ClawHub

Only if `lyclaw-marketplace` fails or returns no match:

```bash
clawhub search "keyword"
clawhub install <slug>
```

Confirm ambiguous public matches with the user.
