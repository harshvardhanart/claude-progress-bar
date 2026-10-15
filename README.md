# task-progress

A live progress bar for Claude Code. It sits above the message box and shows:

- the current step and how many steps are done (`2/5 · 40%`)
- ⏱ elapsed time and an estimate of the time left
- 🪙 tokens used so far for the current request

It appears for every request, updates as Claude works, and resets when a new job starts.
On the desktop app it is a glowing gradient bar; in the terminal it is a segmented colour bar.

## Install

### From GitHub (recommended)

In a Claude Code terminal session:

```
/plugin install task-progress --marketplace harshvardhanart-del/claude-progress-bar
```

Answer `y` to add the marketplace and pick the **user** scope so it works in every project.

### From this folder (zip)

1. Unzip it somewhere permanent, for example `C:\Users\<you>\.claude\local-plugins\task-progress`.
2. In a terminal, run:

```
claude plugin marketplace add "C:\Users\<you>\.claude\local-plugins\task-progress"
claude plugin install task-progress@harsh-mods --scope user
```

3. Restart Claude Code, or type `/reload-plugins` in an open chat.

## Use

- The bar shows up by itself when you send a message.
- **Hide** hides it; `/progress` brings it back; `/progress hide` hides it again.

## Requirements

A Claude Code build with plugin function hooks (the engine that runs `hooks/register.tsx`).

Made by **Harsh Vardhan**.
