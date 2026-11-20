import { startEndpoint } from "./transport.mjs";

const endpoint = await startEndpoint({
	directory: process.argv[2],
	describe: () => ({ name: "test-child", pid: process.pid }),
	receive: (message) => {
		endpoint.send(message.sender.id, `Reply: ${message.message}`).then(
			() => process.send({ status: "replied" }),
			(error) => { console.error(error); process.exitCode = 1; process.disconnect(); },
		);
	},
});
process.on("message", async () => {
	await endpoint.close();
	process.disconnect();
});
process.send(endpoint.identity());
