# Perch CLI

Version 2.4.112 adds MiniMax M3.1 Flash to Starter for a limited time
(`/model minimax-m3.1-flash-starter`).

Version 2.4.110 adds DeepSeek V4.1 Flash (1017) as a Pro model, right after
GPT-6.1 Sol (`/model deepseek-v4.1-flash-1017`), and Beam 1.0 as a Pro model
(`/model beam-1.0`). Beam 1.0 is also on Starter until October 23, 2026
(`/model beam-1.0-starter`).

Version 2.4.108 adds Gemini 4 Argon as a Pro model, at the top of the Pro
list (`/model gemini-4-argon`), above Claude Opus 5.5.

Version 2.4.107 adds Claude Opus 5.5 as a Pro model, at the top of the Pro
list (`/model claude-opus-5.5`).

Version 2.4.106 adds Claude Sonnet 5.5 and Claude Haiku 5.5 as Pro models,
listed right after GPT-6.1 Sol and GPT-6 Luna, and Grok 4.7 as a Pro model
above Grok 4.6.

Version 2.4.105 includes the new composer with cursor editing, paste chips,
history search and external-editor support, plus styled Markdown replies.
Launch-week Qwen Flash, Qwen Max 0902 and GPT-6.1 Sol selections show `(Promo)`
until October 13, 2026 at 2:30 p.m. Eastern. Starter gets the two Qwen options;
Pro promo pins use fair-use allowance first and ask before using Manual usage.

Run Perch from a terminal without installing the Desktop app.

```sh
npm install -g perchai-cli
perch login
perch status
perch --cwd ~/Desktop/Project --permission take_the_wheel
perch run "Summarize this folder" --cwd .
perch ap packet ./01-ap
```

`perch login` opens your browser, completes OAuth through Perch, and saves the CLI session in the macOS Keychain or `~/.perch/cli-auth-session.json` on other platforms.

Interactive mode restores your last persona, mode, permission, model/tier, effort, sub-agent model, and local-tools choices from `~/.perch/cli-settings.json`. MCP servers configured in `~/.perch/mcp.json` or `<workspace>/.perch/mcp.json` are available as CLI tools; the Playwright/browser MCP remains Desktop-only.

## Interactive Commands

Run `perch`, then use these commands inside the terminal chat:

- `/help` — show commands.
- `/status` — show cwd, auth, mode, persona, permission, and thread.
- `/usage` — show tokens and estimated cost for this session.
- `/cwd [dir]` — show or change the working directory.
- `/permission [default|auto_review|take_the_wheel|plan]` — show or change permission mode.
- `/permissions [default|auto_review|take_the_wheel|plan]` — alias for `/permission`.
- `/mode [ask|agents|plan]` — show or change chat mode.
- `/persona [saffron|quill]` — show or change persona.
- `/context` — show context meter and compaction details.
- `/local-tools [on|off]` — show or toggle local shell/file tools.
- `/thread [new|id]` — show, reset, or set the current thread id.
- `/clear` — clear local conversation memory for this terminal session.
- `/login` — sign in through browser OAuth.
- `/logout` — clear saved CLI auth.
- `/exit` — leave Perch CLI.
- `/delegate <task>` — launch a background delegate (`/bg` alias). Approve/dismiss on Desktop; use `check_delegate` tool in CLI turns.
- `/flock <task>` — experimental multi-agent mode (hidden; see repo `docs/FLOCK_MODE.md`).

## Composer Keys

Run `/keys` for the full list. The highlights:

- `Enter` sends. `Shift+Enter` (kitty, WezTerm, ghostty), `Alt/Option+Enter`, `Ctrl-J`, or a trailing `\` then `Enter` inserts a new line.
- `↑`/`↓` move between rows and recall earlier prompts at the edges. `Ctrl-R` searches prompt history.
- `Ctrl-Z` undoes, `Ctrl-G` opens the draft in `$VISUAL` / `$EDITOR`, `Ctrl-L` clears the screen.
- `Esc` (or `Ctrl-C`) stops a running turn. On an empty composer, press `Ctrl-C` twice or `Ctrl-D` to exit.
- Large pastes collapse into a `[Pasted text #N · X lines]` chip; the full text is what gets sent.

Prompt history is saved to `~/.perch/cli-history.json` (prompts over 8,000 characters stay in memory only). Environment switches:

- `PERCH_CLI_HISTORY=0` keeps history in memory only.
- `PERCH_CLI_NATIVE_CURSOR=0` paints a block cursor instead of moving the terminal's own cursor.
- `PERCH_CLI_KITTY_KEYBOARD=0` turns off the kitty keyboard protocol.
- `PERCH_CLI_RESERVE_LAST_COLUMN=1` keeps the terminal's last column empty, which stops repeated lines in terminals that wrap early. It is on by default on Windows; `0` turns it off.

## Replies

Replies render as Markdown in an interactive terminal: headings, bold and italic, lists, quotes, tables, links, and syntax-colored code blocks. Finished paragraphs settle while the rest of the reply streams in. Piped output and `--json` keep the raw text.

- `PERCH_CLI_MARKDOWN=0` shows replies as raw text.
- `PERCH_CLI_HYPERLINKS=1` makes link text clickable (OSC 8) in any terminal; `0` turns it off. By default it is on for iTerm2, WezTerm, kitty, ghostty, Warp, VS Code, Windows Terminal, and recent VTE terminals, and off inside tmux and screen. The URL is always printed next to the link text.

## Docs

Full CLI architecture and codebase navigation live in the main repo:

- [docs/PERCH_CLI_USAGE.md](https://github.com/Perch-Terminal-AI/APP-PERCH-AI/blob/main/docs/PERCH_CLI_USAGE.md)
- [docs/INDEX.md](https://github.com/Perch-Terminal-AI/APP-PERCH-AI/blob/main/docs/INDEX.md)
