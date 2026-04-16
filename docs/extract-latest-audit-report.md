# Extract Latest Audit Report

This is the shortest reliable way to extract the latest stored audit report from `apps/server/qwery.db`.

## 1. Find the latest conversation

```bash
ls -lt apps/server/qwery.db/conversation
```

Take the newest conversation id, for example:

```text
04f5f021-c948-4c04-902a-c44c1deeebfd.json
```

## 2. Find the latest message for that conversation

```bash
ls -lt apps/server/qwery.db/message/<conversation-id>
```

Example:

```bash
ls -lt apps/server/qwery.db/message/04f5f021-c948-4c04-902a-c44c1deeebfd
```

Use the newest message file.

## 3. Read the final report text

Search for the final report block:

```bash
rg -n "PostgreSQL Performance Audit Report|Audit incomplete" apps/server/qwery.db/message/<conversation-id>/<message-id>.json
```

Then open the file around that line and extract the `text` field.

## One-liner workflow

```bash
ls -lt apps/server/qwery.db/conversation
ls -lt apps/server/qwery.db/message/<conversation-id>
rg -n "PostgreSQL Performance Audit Report|Audit incomplete" apps/server/qwery.db/message/<conversation-id>/<message-id>.json
```

## Notes

- Conversation files tell you which datasource was attached.
- The final report is usually in the newest assistant message file for that conversation.
- If multiple report-like blocks exist, use the one nearest the end of the message file.
