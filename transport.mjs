import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// JSON can expand one message byte into six bytes (for example, a control character).
const MAX_FRAME = 128 * 1024;
export const MAX_MESSAGE = 16 * 1024;
export const defaultDirectory = () => join(tmpdir(), `pi-intercom-${process.getuid()}`);

async function privateDirectory(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
		throw new Error("Intercom requires a private directory owned by the current user.");
	}
}

function socketPath(directory, id) {
	if (!ID.test(id)) throw new Error("Use an exact intercom ID from intercom_list.");
	const path = join(directory, `${id}.sock`);
	if (Buffer.byteLength(path) > 100) throw new Error("Intercom socket path is too long.");
	return path;
}

export function validateMessage(message) {
	if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > MAX_MESSAGE) {
		throw new Error("Message must contain text and use no more than 16384 UTF-8 bytes.");
	}
}

// Each connection carries one bounded JSON line.
function readFrame(socket, onFrame, onError) {
	let bytes = 0;
	let chunks = [];
	let complete = false;
	socket.on("data", (chunk) => {
		if (complete) return;
		bytes += chunk.length;
		if (bytes > MAX_FRAME) {
			complete = true;
			onError(new Error("Intercom frame is too large."));
			return;
		}
		chunks.push(chunk);
		if (!chunk.includes(10)) return;
		complete = true;
		const frame = Buffer.concat(chunks);
		chunks = [];
		let value;
		try {
			value = JSON.parse(frame.subarray(0, frame.indexOf(10)).toString("utf8"));
		} catch {
			onError(new Error("Invalid intercom JSON."));
			return;
		}
		onFrame(value);
	});
}

export function request(directory, id, payload, { signal, timeout = 1500 } = {}) {
	const path = socketPath(directory, id);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Intercom request cancelled."));
		const socket = createConnection(path);
		let done = false;
		let dispatched = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		const abort = () => finish(new Error("Intercom request cancelled; delivery may have occurred."));
		const timer = setTimeout(() => finish(new Error("Intercom request timed out; delivery is unknown. Do not retry blindly.")), timeout);
		signal?.addEventListener("abort", abort, { once: true });
		socket.on("error", (error) => finish(dispatched
			? new Error(`${error.message}; delivery is unknown. Do not retry blindly.`)
			: error));
		socket.on("end", () => finish(new Error("Intercom closed without a receipt; delivery is unknown.")));
		socket.on("connect", () => {
			dispatched = true;
			socket.write(`${JSON.stringify(payload)}\n`);
		});
		readFrame(socket, (reply) => {
			if (reply?.ok !== true) finish(new Error(reply?.error || "Intercom request failed."));
			else finish(null, reply);
		}, (error) => finish(error));
	});
}

export async function startEndpoint({ directory = defaultDirectory(), describe, receive }) {
	await privateDirectory(directory);
	const id = randomUUID();
	const path = socketPath(directory, id);
	const sockets = new Set();
	let closed = false;
	const identity = () => ({ ...describe(), id });
	const server = createServer((socket) => {
		if (closed || sockets.size >= 32) return socket.destroy();
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setTimeout(2000, () => socket.destroy());
		const reply = (data) => socket.end(`${JSON.stringify(data)}\n`);
		readFrame(socket, (data) => {
			try {
				if (closed) throw new Error("Intercom is shutting down.");
				if (data?.op === "ping") return reply({ ok: true, peer: identity() });
				if (data?.op !== "send" || !ID.test(data.sender?.id) || !ID.test(data.messageId)) {
					throw new Error("Invalid intercom request.");
				}
				validateMessage(data.message);
				if (data.sender.id === id) throw new Error("Cannot send an intercom message to yourself.");
				// Sender metadata is a claim from another process under the same OS user.
				const message = { messageId: data.messageId, sender: data.sender, message: data.message };
				receive(message);
				reply({ ok: true, messageId: data.messageId, recipient: id, status: "accepted" });
			} catch (error) {
				reply({ ok: false, error: error.message });
			}
		}, (error) => reply({ ok: false, error: error.message }));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	// The active Pi session, not this socket, owns process lifetime.
	server.unref();
	let closing;
	return {
		id,
		identity,
		async list(signal) {
			const peers = [];
			const entries = (await readdir(directory)).filter((name) => name.endsWith(".sock") && ID.test(name.slice(0, -5)));
			// Bound concurrent probes. Dead sockets remain harmless until temporary-file cleanup.
			for (let i = 0; i < entries.length; i += 16) {
				if (signal?.aborted) throw new Error("Intercom discovery cancelled.");
				await Promise.all(entries.slice(i, i + 16).map(async (name) => {
					try {
						const reply = await request(directory, name.slice(0, -5), { op: "ping" }, { signal, timeout: 300 });
						if (reply.peer?.id === name.slice(0, -5)) peers.push(reply.peer);
					} catch { /* A closed or unresponsive session is not discoverable. */ }
				}));
			}
			if (signal?.aborted) throw new Error("Intercom discovery cancelled.");
			return peers.sort((a, b) => a.id.localeCompare(b.id));
		},
		async send(target, message, signal) {
			if (closed) throw new Error("Intercom is not active.");
			if (target === id) throw new Error("Cannot send an intercom message to yourself.");
			validateMessage(message);
			return request(directory, target, { op: "send", messageId: randomUUID(), sender: identity(), message }, { signal });
		},
		close() {
			if (closing) return closing;
			closed = true;
			closing = new Promise((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
				for (const socket of sockets) socket.destroy();
			}).then(async () => {
				await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
			});
			return closing;
		},
	};
}
