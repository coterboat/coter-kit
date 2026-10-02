"""Pull only the user's own typed messages out of this machine's Claude Code transcripts.

Usage: python3 extract_user_messages.py OUTPUT_FILE [--since YYYY-MM-DD]

Reads ~/.claude/projects/*/*.jsonl. Skips system reminders, slash-command wrappers,
tool results and subagent turns. Long messages are cut to 1500 characters. Nothing
leaves the machine.
"""
import glob
import json
import os
import re
import sys

SKIP_PREFIXES = ("<command-", "<local-command", "Caveat:", "<task-notification", "[Request interrupted", "<create-pr-command")


def user_texts(path, since):
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") != "user" or row.get("isMeta") or row.get("isSidechain"):
            continue
        stamp = row.get("timestamp", "")[:16]
        if since and stamp[:10] < since:
            continue
        content = row.get("message", {}).get("content")
        if isinstance(content, str):
            texts = [content]
        elif isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        else:
            texts = []
        for text in texts:
            text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S).strip()
            if not text or text.startswith(SKIP_PREFIXES) or "This session is being continued" in text[:200]:
                continue
            if len(text) > 1500:
                text = text[:1500] + f" …[+{len(text) - 1500} chars]"
            yield stamp, text


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out_path = sys.argv[1]
    since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else ""
    root = os.path.expanduser("~/.claude/projects")
    out, seen, count, files = [], set(), 0, 0
    for path in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        project = os.path.basename(os.path.dirname(path))
        rows = []
        for stamp, text in user_texts(path, since):
            # Resumed and forked sessions repeat earlier messages; keep each once
            key = (stamp, text[:200])
            if key in seen:
                continue
            seen.add(key)
            rows.append(f"[{stamp}] {text}")
        if rows:
            out.append(f"\n===== {project} :: {os.path.basename(path)} ({len(rows)} msgs) =====")
            out.extend(rows)
            count += len(rows)
            files += 1
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"{count} messages from {files} transcripts -> {out_path}")


if __name__ == "__main__":
    main()
