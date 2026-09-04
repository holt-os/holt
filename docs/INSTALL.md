# Installing Holt

This page is written for two readers: a person who wants Holt on their machine,
and an AI agent (Claude Code, Codex, Gemini) doing the install on their behalf.

If you are a person and you want the short version, skip to
[The one-line way](#the-one-line-way).

***

## The one-line way

Install [Claude Code](https://claude.com/claude-code) first, open it, and paste
this:

```
Set up Holt for me: read https://raw.githubusercontent.com/holt-os/holt/main/docs/INSTALL.md and follow it exactly.
```

That is the whole thing. Claude reads the rest of this page and does the install,
checks its own work, and tells you when you are ready. If something fails, it can
see the error and fix it, which is the part a written guide cannot do for you.

Do not paste a long install script into a chat window. It gets mangled in
transit, and a half-pasted script fails in confusing ways.

### Step 1: install Claude Code

**Windows.** Search the Start menu for **PowerShell**, open it, paste this, press
Enter:

```powershell
irm https://claude.ai/install.ps1 | iex
```

You do not need WSL. Windows 10 (build 1809) or newer works natively.

**macOS or Linux.** Open Terminal, paste this, press Enter:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**If your machine blocks scripts from the internet,** use a package manager
instead. macOS: `brew install --cask claude-code`. Windows:
`winget install Anthropic.ClaudeCode`.

Then close that window, open a new one, and check it worked:

```
claude --version
```

A version number means you are set. Anything else, see
[When install goes wrong](#when-install-goes-wrong).

### Step 2: sign in

Run `claude`. A browser opens; sign in with your Claude account.

**Claude Code needs a paid plan.** Pro at 20 USD a month is the cheapest, and
Max and Team also work. The free Claude.ai plan does not include Claude Code. If
you are attending a workshop, sort this out before the session starts, not
during it.

### Step 3: paste the prompt

Paste the line from the top of this page. You are done.

***

## What you need

| | Minimum |
|---|---|
| Operating system | macOS 13+, Windows 10 build 1809+, Ubuntu 20.04+, Debian 10+ |
| Memory | 4 GB RAM |
| Node.js | 20 or newer, and only if installing Holt through npm |
| Internet | Required, and Claude must be available in your country |

An old laptop is usually fine. 4 GB of RAM is the real floor: below that the
install itself can be killed partway through.

***

## For the agent doing the install

Follow this in order. Do not skip the verification step; a silent partial
install is the failure mode that wastes the most of the user's time.

### 1. Check the ground

```
node --version
```

Holt needs Node 20 or newer. If Node is missing or older, prefer Homebrew on
macOS (`brew install holt-os/tap/holt` brings its own Node, so this resolves
both problems at once). On Windows or Linux, install Node 20+ first from
[nodejs.org](https://nodejs.org), then continue.

### 2. Install Holt

macOS, and the better option because it handles Node for you:

```
brew install holt-os/tap/holt
```

Anywhere with Node 20+ already present:

```
npm install -g @holt-os/holt
```

Holt has no runtime dependencies, no native modules, and no postinstall script,
so this step is normally quick and quiet. If `npm install -g` fails with a
permissions error, do **not** rerun it with `sudo`. Either use Homebrew, or
point npm at a user-writable prefix.

### 3. Verify before going further

```
holt version
holt doctor
```

`holt doctor` reports what is missing and what it can repair. If it offers a
repair and the user agrees, `holt doctor --fix` will start Ollama, pull the
embedding model, and mend a damaged config.

Report the real result. If `holt version` did not print a version, the install
did not work, and saying it did wastes the user's time.

### 4. Set up their first folder

Ask the user which folder should hold their work, and make one if they have no
answer. Then:

```
cd <that folder>
holt init
```

`holt init` walks through trusting the folder, choosing a brain, signing in,
picking a default, and offering local semantic memory. Let the user answer these
themselves rather than choosing for them; the trust prompt in particular is
theirs to give.

Say yes to semantic memory if the machine can take it. It installs a local
[Ollama](https://ollama.com) with a small embedding model, everything stays on
the machine, and recall gets substantially better. On macOS Holt can install it
automatically. On Windows and Linux the user installs Ollama themselves; Holt
prints the link. Without it, Holt still works, matching on keywords instead.

### 5. Turn on ambient memory

```
holt hook install
```

This wires Holt's memory into Claude Code so it recalls and remembers with no
manual step. It is the single highest-value command after setup, and it is easy
to forget.

### 6. Hand over at the right place

Do not stop at "installed". An empty Holt is an unconvincing Holt. Finish by
starting the interview that fills its memory:

```
/skill onboard
```

Then tell the user, in one line, what to do next. Not a menu.

***

## When install goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `command not found: claude` or `holt` | Installed, but the shell cannot find it | Close the terminal and open a new one. If it persists, add `~/.local/bin` to PATH |
| `syntax error near unexpected token` | A proxy or firewall returned a web page instead of the script | Use the package manager route: `brew install --cask claude-code` or `winget install Anthropic.ClaudeCode` |
| `curl: (403) Forbidden` | Corporate proxy blocking the download | Set `HTTPS_PROXY` to the proxy your IT team gives you, then retry |
| `irm is not recognized` | You are in Command Prompt, not PowerShell | Open PowerShell from the Start menu and try again |
| `Killed` during install | The machine ran out of memory | Close everything else and retry. On Linux, add swap |
| `EACCES` on `npm install -g` | npm cannot write to the global folder | Use Homebrew, or set a user-writable npm prefix. Do not use `sudo` |
| TLS or certificate errors | Out-of-date root certificates, or proxy inspection | Update the OS. On Linux, `sudo apt-get install ca-certificates` |

Diagnostics: `claude doctor` for Claude Code, `holt doctor` for Holt. Run both
before guessing.

***

## If your employer blocks installing software

This is common and it is worth checking **before** a workshop rather than during
one.

[claude.ai/code](https://claude.ai/code) runs Claude Code in the browser with
nothing installed locally. It needs a paid plan, and it runs in Anthropic's
sandbox rather than on your machine.

That last part matters for Holt: Holt's whole point is that your memory lives on
your own machine, and a browser sandbox is not your machine. Anything you build
there does not persist to your laptop. If your work machine is locked down, the
honest options are a personal machine, or asking IT for an exception.

***

## Known gaps

Worth knowing before you rely on them:

- **Automatic Ollama setup is macOS only.** Elsewhere Holt prints the download
  link and you install it yourself.
- **Windows timers need the machine awake.** `holt schedule` and a routine's
  `--at` register a real Task Scheduler entry, but a missed run is skipped
  rather than caught up when the laptop was asleep or off at that time.
- **Git is needed for `holt skill add` from a URL.** Nothing else needs it.
