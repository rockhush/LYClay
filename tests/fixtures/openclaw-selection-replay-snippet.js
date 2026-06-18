import { a as isSilentReplyText, i as isSilentReplyPrefixText, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, r as isSilentReplyPayloadText, s as stripLeadingSilentToken } from "./tokens-BlOFOAQM.js";
import { C as stripInternalMetadataForDisplay } from "./session-utils.fs-t4aVetyM.js";

function installSessionToolResultGuard(sessionManager, opts) {
	const guardedAppend = (message) => {
		let nextMessage = message;
		const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
		if (!finalMessage) return;
		const finalRole = finalMessage.role;
		return finalRole;
	};
	sessionManager.appendMessage = guardedAppend;
}

function normalizeAssistantReplayTextContent(message, replayContent) {
	const strippedText = stripInternalMetadataForDisplay(replayContent);
	const trimmed = strippedText.trim();
	if (!trimmed || isSilentReplyPayloadText(trimmed, "NO_REPLY")) return null;
	return {
		...message,
		content: [{
			type: "text",
			text: strippedText
		}]
	};
}

function normalizeAssistantReplayBlockContent(message, replayContent) {
	let touched = false;
	const sanitizedContent = [];
	for (const block of replayContent) {
		if (!block || typeof block !== "object") {
			sanitizedContent.push(block);
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") {
			sanitizedContent.push(block);
			continue;
		}
		const strippedText = stripInternalMetadataForDisplay(text);
		if (strippedText === text) {
			if (!isSilentReplyPayloadText(text.trim(), "NO_REPLY")) sanitizedContent.push(block);
			else touched = true;
			continue;
		}
		touched = true;
		const trimmed = strippedText.trim();
		if (trimmed && !isSilentReplyPayloadText(trimmed, "NO_REPLY")) sanitizedContent.push({
			...block,
			text: strippedText
		});
	}
	if (!touched) return message;
	if (sanitizedContent.length === 0) return null;
	return {
		...message,
		content: sanitizedContent
	};
}
