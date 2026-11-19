import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function entryTime(entry: any): number | undefined {
	if (entry?.type === "message" && typeof entry.message?.timestamp === "number") {
		return entry.message.timestamp;
	}
	if (typeof entry?.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function outputTokens(message: any): number {
	const usage = message?.usage;
	return Number(usage?.output ?? usage?.outputTokens ?? 0);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("speed", {
		description: "Show average output tokens/sec for the current model",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is selected.", "warning");
				return;
			}

			const currentModel = `${model.provider}/${model.id}`;
			const entries = ctx.sessionManager.getBranch();

			let totalTokens = 0;
			let totalMs = 0;
			let samples = 0;

			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i] as any;
				if (entry?.type !== "message") continue;

				const message = entry.message;
				if (message?.role !== "assistant" || message.model !== model.id) continue;

				const tokens = outputTokens(message);
				const start = i > 0 ? Date.parse(String(entries[i - 1]?.timestamp)) : NaN;
				const end = Date.parse(String(entry?.timestamp));

				if (!Number.isFinite(tokens) || tokens <= 0) continue;
				if (!Number.isFinite(end) || !Number.isFinite(start) || start === undefined) continue;

				const durationMs = end - start;
				if (durationMs <= 0) continue;

				totalTokens += tokens;
				totalMs += durationMs;
				samples++;
			}

			if (samples === 0 || totalMs <= 0) {
				ctx.ui.notify(`No speed samples for ${currentModel}.`, "info");
				return;
			}

			const tps = totalTokens / (totalMs / 1000);
			ctx.ui.notify(
				`${currentModel}: ${tps.toFixed(1)} tok/s avg over ${samples} response${samples === 1 ? "" : "s"}`,
				"info",
			);
		},
	});
}
