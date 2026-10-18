# 🧭 dsh-retrace

> A session time machine for DeepSeek Harness — a personal compatibility-fix fork of
> [yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace). Current version: **0.4.55**.

Recall a whole turn, edit-and-resend a past prompt, or regenerate a reply — while the
conversation state and the workspace files it touched are versioned together. Every rollback
is a legal append-only session event, so the log stays clean and `/compact` keeps working.

**简体中文** · [中文详细说明](./README.zh.md)

---

## 📦 Install

```sh
# Desktop
dsh plugin --profile desktop add github:daha1216/dsh-retrace

# Web deployment
dsh plugin --profile web add github:daha1216/dsh-retrace
```

Restart DSH (and refresh the page) after installing or updating — a running app does not
hot-load bundles. If `dsh` is not on your PATH, prefix the command with
`npx --yes -p @deepseek-ai/dsh`.

> This fork is not published to npm under its own name; `add dsh-retrace` installs the
> upstream package and does **not** include the fixes below. Install from GitHub, or from a
> local checkout with `dsh plugin --profile desktop add /path/to/dsh-retrace`.

---

## ✨ Features

- **↩ Recall** — remove an entire turn (prompt + reply + tool rows) from both model context
  and the chat view; the original prompt is echoed back into the composer.
- **✎ Edit & resend** — edit a past user message in place and re-answer, with a collapsible
  "original prompt" reference.
- **↻ Regenerate** — keep the prompt, hide the previous reply, and let the agent answer again.
- **🕘 Version timeline** — every rollback becomes a version (kind / time / message count /
  file changes), pushed live via `session/projection`.
- **↩️ Artifact rollback** — conversation only, files only, or both, with a dry-run preview;
  git first, content-addressed snapshots as fallback; a rollback is itself a new version.
- **🧭 Fork map & lineage** — visualize branch points and parent-session lineage.
- **🗂️ Session archaeology CLI** — read-only index / query / extract / file-history over
  persisted session logs.

---

## 🔄 Recent changes (0.4.50 → 0.4.55)

- **0.4.55** — dark-mode visual fixes. Several tokens were used with the wrong semantics or
  never defined at all, which broke the recall editor, marker pills, reference blocks and the
  settings switches in dark theme: `--dsw-alias-bg-elevated`, `--dsw-alias-fill-l2`,
  `--dsw-alias-state-warning-primary`, `--dsw-alias-state-info-primary`,
  `--dsw-alias-state-success-bg` and `--dsw-font-mono` are undefined in DSH; they now map to
  `--dsw-alias-bg-layer-3`, `--dsw-alias-interactive-bg-hover`,
  `--dsw-alias-state-warn-primary`, `--dsw-alias-state-business-primary`,
  `--dsw-alias-state-success-tertiary` and `--ds-font-family-code`. The orange send button's
  white label sat at 2.26:1 on orange and is now dark `#20160b` (7.86:1), with the error
  confirm button that reuses its styles restoring its own foreground. The settings switches
  now follow the host's token pairing (off: `border-l3` + `switch-thumb`; on:
  `button-primary-fill` + `label-primary-foreground`), lifting knob contrast from about 2:1
  to 18:1 in dark theme. Hard-coded `rgba(0,0,0,…)` shadows moved to
  `--dsw-shadow-lv1` / `--dsw-shadow-lv2`. The orange palette is the plugin's own design
  language and stays as is.
- **0.4.54** — `git init` now passes the session's sandbox policy, fixing `.gitignore` writes
  being denied under `workspace-write`.
- **0.4.53** — fixed `git init` passing a string path where the fs seam expects a resolved
  target (TypeError); hardened the create-if-absent `.gitignore` path.
- **0.4.52** — settings changes merge instead of overwriting and sync across tabs; HTTP errors
  carry real status codes (400/403/404/409/413/503); dead code paths removed.
- **0.4.51** — span failures report distinct codes (`log-unavailable` vs `target-shadowed`);
  flush failures surface as warnings instead of being swallowed; session-log reads are cached
  by size+mtime; client hook lookups are indexed (no more O(N²) per row); switching sessions no
  longer leaks state between views.
- **0.4.50** — fixed cross-session GC deleting other sessions' snapshots; serialized GC against
  snapshot writes with a 10-minute grace window; `retentionLimit` now actually bounds snapshots;
  artifact rollback uses the version boundary's HEAD and refuses to overwrite a dirty worktree;
  `session.vN.jsonl.zstd` logs are resolved correctly; plugin HTTP routes enforce same-origin +
  JSON-only with reflected CORS; badge / title / water-level operations are reachable over HTTP;
  shared per-session locks; 15-second agent-stop timeout; two-step assistant recall; composer
  draft protection and IME-safe key handling.

---

## ⚙️ Settings → Recall

| Setting | Default | Notes |
|---|---|---|
| Show original-prompt reference | on | Collapsible reference under a resent message (display only). |
| Start from a new conversation after edit | off | Hide everything before the edited prompt as well. |
| Hide replaced messages by marker | on | Auto-degrades to visible when a marker would hide >40% of the conversation. |
| Version & artifact snapshots | on | Records a version per rollback; off = context-only rollback. |
| Git integration | on | Uses git when the workspace is a repo; one-click init is available in the timeline. |
| Version retention limit | 50 | Keeps snapshots for the most recent N versions (1–1000); the timeline keeps its own records (up to 200). |

---

## ⚠️ Requirements & limits

- Only user messages can be edited; recall works for both user and assistant messages.
- The agent must be idle. A running reply is cancelled and awaited, up to 15 seconds
  (`agent-stop-timeout`).
- Recall / edit target the active model surface: compressed or already-shadowed messages are
  rejected (`target-shadowed`), and unreadable or sparse session events report
  `log-unavailable`.
- Artifact rollback refuses to run when the worktree has uncommitted changes
  (`working-tree-dirty`); commit or discard them first.
- Regenerate resends only the text part of the prompt; prompts with images fall back to
  text-only.

---

## 🛠️ Development notes

This repo ships the source, not the private build toolchain:

```
lib/host-core.js       # transport-agnostic host logic
lib/index.js           # published host: service wiring + HTTP routes
lib/client.js          # client source (readable, React)
lib/client.bundle.js   # runtime entry (self-registering loader), kept in sync with client.js
lib/http.js            # HTTP seam (same-origin, JSON-only, status-coded errors)
lib/versioning.js      # snapshots, GC, git facts
lib/rollback.js        # context / artifact rollback executor
lib/artifact-store.js  # content-addressed store (~/.dsh/dsh-retrace/objects)
lib/git-adapter.js     # git status / checkout / init over the subprocess seam
lib/adapter/           # DSH session-log adapter + marker writer
scripts/e2e-layout.cjs # layout E2E (needs an external playwright install)
```

- `scripts/build-client.mjs`, `scripts/generate-dynamic.mjs`, `test/` and CI workflows are
  **not** part of this fork — don't run `pnpm build` / `pnpm test`.
- Client changes must be made in **both** `lib/client.js` and `lib/client.bundle.js`, and both
  must pass `node --check`.
- `lib/dynamic-*.js` are generated artifacts and currently lag the published bundle (0.4.43);
  install the bundle form.
- Syntax check: `node --check lib/*.js` (`dynamic-client.js` / `dynamic-host.js` report
  `Illegal return statement` by design — they are injected function bodies).

---

## 📄 License

MIT. Original project © OfferKuai / Zhaofeng (Yaming); this fork maintained by
[daha1216](https://github.com/daha1216).
