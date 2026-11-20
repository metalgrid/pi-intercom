# Pi intercom

Send messages between running Pi sessions on the same machine and under the same OS user.

## Load

This directory lives at `~/.pi/agent/extensions/intercom/`. Pi discovers `index.ts` automatically.

Run `/reload` in each existing session, or start new sessions. Both sessions must load the extension.

## Tools

- `intercom_list {}` lists active recipients and your own ID.
- `intercom_send {"target":"<intercom ID>","message":"<text>"}` sends a message.

Each list entry contains an intercom ID, Pi session ID, session name, working directory, process ID, and busy or idle status.
Use the exact **intercom ID** as the target, not the Pi session ID.

Every message includes the sender's intercom ID. Use that ID as the target when you reply.
Do not send automatic acknowledgments. Reply only when a response is necessary.

Example request to your agent:

> Find the Pi session working in `/path/to/project` and ask it which files it is changing.

The extension adds a visible custom message, not a user message. It starts a turn when the recipient is idle.
For a busy recipient, Pi queues a follow-up after its current work.

## Delivery limits

- A receipt means the extension handed the message to Pi. It does not prove model processing or task completion.
- Pi can report later delivery or model errors in the recipient session.
- Messages contain at most 16 KiB of UTF-8 text.
- A timeout or connection loss can leave delivery unknown. Do not retry without checking the recipient.
- There is no offline queue, automatic retry, broadcast, or automatic reply.
- A reload, session switch, or restart creates a new intercom ID. Old IDs cannot address the replacement session.
- Queued messages can be lost if the recipient exits or changes sessions before Pi processes them.

## Local access

Each session opens a Unix socket in `$TMPDIR/pi-intercom-<uid>/`, or the system temporary directory when `TMPDIR` is unset.
The directory must belong to the current user and have no group or other permissions.
Sessions must use the same temporary directory to find each other.

Discovery probes sockets directly. There is no central server or registry file.
Normal shutdown removes the session's socket. Discovery ignores stale sockets after a process crash.

This is not a security boundary between processes under the same OS user.
Such processes can connect and claim a sender identity. Received messages grant no permissions and do not replace user instructions.

## Tests

Run the transport tests:

```sh
node --test transport.test.mjs
```

Run all tests with Pi's real extension loader:

```sh
PI_PACKAGE_ROOT=/absolute/path/to/installed/pi-coding-agent node --test *.test.mjs
```

The extension test uses a mocked Pi message receiver. It does not call a model or send messages to existing sessions.
Without `PI_PACKAGE_ROOT`, Node skips that test.
