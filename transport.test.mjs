import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request, startEndpoint } from "./transport.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-ic-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const received = [[], []];
	const peers = [];
	for (let i = 0; i < 2; i++) {
		const peer = await startEndpoint({ directory, describe: () => ({ name: `peer-${i}`, sessionId: `session-${i}` }), receive: (message) => received[i].push(message) });
		peers.push(peer);
		t.after(() => peer.close());
	}
	return { directory, peers, received };
}

test("discovery, sender identity, receipt, Unicode, and replies", async (t) => {
	const { peers: [a, b], received } = await fixture(t);
	assert.deepEqual((await a.list()).map((p) => p.id).sort(), [a.id, b.id].sort());
	const receipt = await a.send(b.id, "Hello 🌍\nSecond line");
	assert.equal(receipt.status, "accepted");
	assert.equal(received[1][0].sender.id, a.id);
	assert.equal(received[1][0].sender.sessionId, "session-0");
	assert.equal(received[1][0].messageId, receipt.messageId);
	assert.equal(received[1][0].message, "Hello 🌍\nSecond line");
	await b.send(received[1][0].sender.id, "Reply");
	assert.equal(received[0][0].message, "Reply");
});

test("messages and replies cross process boundaries", { timeout: 5000 }, async (t) => {
	const { directory, peers: [a], received } = await fixture(t);
	const child = fork(new URL("./test-peer.mjs", import.meta.url), [directory], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	t.after(async () => {
		if (child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	});
	const [identity] = await once(child, "message");
	assert.notEqual(identity.pid, process.pid);
	const reply = once(child, "message");
	await a.send(identity.id, "Across processes");
	const [receipt] = await reply;
	assert.equal(receipt.status, "replied");
	assert.equal(received[0][0].sender.id, identity.id);
	assert.equal(received[0][0].message, "Reply: Across processes");
	const exited = once(child, "exit");
	child.send("close");
	await exited;
	assert.equal((await a.list()).some((p) => p.id === identity.id), false);
});

test("invalid IDs, self-send, empty and oversized messages fail", async (t) => {
	const { peers: [a, b], received } = await fixture(t);
	await assert.rejects(a.send("../../other", "hello"), /exact intercom ID/);
	await assert.rejects(a.send(a.id, "hello"), /yourself/);
	for (const message of ["", "  ", "x".repeat(16385), "🌍".repeat(4097)]) {
		await assert.rejects(a.send(b.id, message), /16384/);
	}
	assert.equal(received[1].length, 0);
	await a.send(b.id, "x".repeat(16384));
	assert.equal(received[1].length, 1);
	await a.send(b.id, "x" + "\u0000".repeat(16383));
	assert.equal(received[1].length, 2);
});

test("close is idempotent and removes only the owned endpoint", async (t) => {
	const { directory, peers: [a, b] } = await fixture(t);
	assert.equal((await lstat(directory)).mode & 0o077, 0);
	await Promise.all([b.close(), b.close()]);
	assert.deepEqual((await a.list()).map((p) => p.id), [a.id]);
	await assert.rejects(a.send(b.id, "hello"), /ENOENT/);
	await assert.rejects(b.send(a.id, "hello"), /not active/);
	assert.deepEqual(await readdir(directory), [`${a.id}.sock`]);
});

test("discovery ignores stale entries and cancellation stops sends", async (t) => {
	const { directory, peers: [a, b], received } = await fixture(t);
	await writeFile(join(directory, `${randomUUID()}.sock`), "stale");
	assert.equal((await a.list()).length, 2);
	const signal = AbortSignal.abort();
	await assert.rejects(a.send(b.id, "hello", signal), /cancelled/);
	await assert.rejects(a.list(signal), /cancelled/);
	assert.equal(received[1].length, 0);
});

test("receiver failures return errors rather than receipts", async (t) => {
	const { directory, peers: [a] } = await fixture(t);
	const b = await startEndpoint({ directory, describe: () => ({}), receive: () => { throw new Error("Not ready"); } });
	t.after(() => b.close());
	await assert.rejects(a.send(b.id, "hello"), /Not ready/);
});

test("rejects shared directories and symlinks", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ic-private-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const options = { directory, describe: () => ({}), receive: () => {} };
	await chmod(directory, 0o755);
	await assert.rejects(startEndpoint(options), /private directory/);
	await chmod(directory, 0o700);
	const link = `${directory}-link`;
	t.after(() => rm(link, { force: true }));
	await symlink(directory, link);
	await assert.rejects(startEndpoint({ ...options, directory: link }), /private directory/);
});

async function raw(directory, id, text) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(join(directory, `${id}.sock`));
		let result = "";
		socket.on("connect", () => socket.write(text));
		socket.on("data", (chunk) => { result += chunk; });
		socket.on("end", () => resolve(JSON.parse(result)));
		socket.on("error", reject);
	});
}

test("malformed and oversized frames do not reach the recipient", async (t) => {
	const { directory, peers: [, b], received } = await fixture(t);
	for (const text of ["not-json\n", "null\n", JSON.stringify({ op: "send" }) + "\n", "x".repeat(131073) + "\n"]) {
		assert.equal((await raw(directory, b.id, text)).ok, false);
	}
	assert.equal(received[1].length, 0);
});

test("unresponsive peers time out with an unknown-delivery warning", async (t) => {
	const { directory } = await fixture(t);
	const id = randomUUID();
	const sockets = [];
	const server = createServer((socket) => sockets.push(socket));
	await new Promise((resolve) => server.listen(join(directory, `${id}.sock`), resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	});
	await assert.rejects(request(directory, id, { op: "ping" }, { timeout: 30 }), /delivery is unknown/);
	const connected = once(server, "connection");
	const controller = new AbortController();
	const cancelled = assert.rejects(request(directory, id, { op: "ping" }, { signal: controller.signal }), /cancelled/);
	await connected;
	controller.abort();
	await cancelled;
	const nextConnection = once(server, "connection");
	const disconnected = assert.rejects(request(directory, id, { op: "ping" }), /delivery is unknown/);
	const [socket] = await nextConnection;
	socket.end();
	await disconnected;
});
