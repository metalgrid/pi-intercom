import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = process.env.PI_PACKAGE_ROOT;

test("Pi loader, tools, custom-message delivery, and session replacement", { skip: !root && "Set PI_PACKAGE_ROOT to the installed Pi package directory." }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-ic-api-"));
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	t.after(async () => {
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
		await rm(directory, { recursive: true, force: true });
	});
	const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")));
	const path = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	async function session(name) {
		const result = await loadExtensions([path], directory);
		assert.deepEqual(result.errors, []);
		const extension = result.extensions[0];
		const messages = [];
		result.runtime.sendMessage = (message, options) => messages.push({ message, options });
		const state = { name, busy: false };
		const ctx = { cwd: directory, isIdle: () => !state.busy, sessionManager: { getSessionId: () => state.name, getSessionName: () => state.name } };
		const emit = async (event) => {
			for (const handler of extension.handlers.get(event) || []) await handler({ type: event }, ctx);
		};
		const tool = (name, args = {}) => extension.tools.get(name).definition.execute("test", args, undefined, undefined, ctx);
		t.after(() => emit("session_shutdown"));
		return { messages, emit, tool, state };
	}
	const a = await session("alpha");
	const b = await session("beta");
	assert.equal((await readdir(directory)).some((name) => name.startsWith("pi-intercom-")), false);
	await a.emit("session_start");
	await b.emit("session_start");
	const aId = (await a.tool("intercom_list")).details.self;
	const bId = (await b.tool("intercom_list")).details.self;
	assert.equal((await a.tool("intercom_list")).details.sessions.length, 2);
	await a.tool("intercom_send", { target: bId, message: "Question" });
	assert.equal(b.messages.length, 1);
	assert.equal(b.messages[0].message.customType, "intercom");
	assert.equal(b.messages[0].message.details.sender.id, aId);
	assert.match(b.messages[0].message.content, /not from the user/);
	assert.deepEqual(b.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	b.state.busy = true;
	assert.equal((await a.tool("intercom_list")).details.sessions.find((p) => p.id === bId).status, "busy");
	await a.tool("intercom_send", { target: bId, message: "While busy" });
	assert.deepEqual(b.messages[1].options, { triggerTurn: true, deliverAs: "followUp" });
	await b.tool("intercom_send", { target: b.messages[0].message.details.sender.id, message: "Answer" });
	assert.equal(a.messages[0].message.details.message, "Answer");
	await b.emit("session_shutdown");
	await assert.rejects(a.tool("intercom_send", { target: bId, message: "Too late" }), /ENOENT/);
	b.state.name = "replacement";
	await b.emit("session_start");
	const newId = (await b.tool("intercom_list")).details.self;
	assert.notEqual(newId, bId);
	assert.equal((await a.tool("intercom_list")).details.sessions.find((p) => p.id === newId).name, "replacement");
	await a.tool("intercom_send", { target: newId, message: "New session" });
	assert.equal(b.messages.length, 3);
});
