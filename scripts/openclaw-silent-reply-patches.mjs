/**
 * Strip trailing/leading NO_REPLY tokens from OpenClaw session replay + transcript persistence.
 * Prevents silent-reply token pollution from being re-fed in context.compiled messages.
 */

export const SILENT_REPLY_PATCH_MARKER = 'sanitizeAssistantReplayVisibleText';

const TOKENS_IMPORT_PATCH_OLD = /r as isSilentReplyPayloadText, s as stripLeadingSilentToken \} from "\.\/tokens-[^"]+\.js";/;
const TOKENS_IMPORT_PATCH_65 = /a as isSilentReplyText, r as isSilentReplyPayloadText \} from "\.\/tokens-[^"]+\.js";/;
const TOKENS_IMPORT_PATCH_REPLACEMENT = 'a as isSilentReplyText, r as isSilentReplyPayloadText, c as stripSilentToken, s as stripLeadingSilentToken, o as startsWithSilentToken, n as SILENT_REPLY_TOKEN } from';

const REPLAY_HELPER = `function sanitizeAssistantReplayVisibleText(text, silentToken = SILENT_REPLY_TOKEN) {
	let next = text;
	if (!next) return "";
	const trimmedInitial = next.trim();
	if (!trimmedInitial || isSilentReplyPayloadText(trimmedInitial, silentToken)) return "";
	if (!isSilentReplyText(next, silentToken)) {
		const hadLeadingSilentToken = startsWithSilentToken(next, silentToken);
		if (hadLeadingSilentToken) next = stripLeadingSilentToken(next, silentToken);
		if (hadLeadingSilentToken || next.toLowerCase().includes(silentToken.toLowerCase())) next = stripSilentToken(next, silentToken);
	}
	const trimmed = next.trim();
	if (!trimmed || isSilentReplyPayloadText(trimmed, silentToken)) return "";
	return next;
}`;

const PERSISTENCE_HELPER = `function sanitizeAssistantMessageForTranscriptPersistence(message) {
	if (!message || message.role !== "assistant") return message;
	const content = message.content;
	if (typeof content === "string") {
		const sanitized = sanitizeAssistantReplayVisibleText(stripInternalMetadataForDisplay(content));
		if (!sanitized.trim()) return null;
		if (sanitized === content) return message;
		return {
			...message,
			content: sanitized
		};
	}
	if (!Array.isArray(content)) return message;
	let touched = false;
	const nextContent = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			nextContent.push(block);
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") {
			nextContent.push(block);
			continue;
		}
		const sanitized = sanitizeAssistantReplayVisibleText(stripInternalMetadataForDisplay(text));
		if (sanitized === text) {
			if (sanitized.trim()) nextContent.push(block);
			else touched = true;
			continue;
		}
		touched = true;
		if (sanitized.trim()) nextContent.push({
			...block,
			text: sanitized
		});
	}
	if (!touched) return message;
	if (nextContent.length === 0) return null;
	return {
		...message,
		content: nextContent
	};
}`;

const NORMALIZE_TEXT_OLD = `function normalizeAssistantReplayTextContent(message, replayContent) {
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
}`;

const NORMALIZE_TEXT_NEW = `function normalizeAssistantReplayTextContent(message, replayContent) {
	const strippedText = sanitizeAssistantReplayVisibleText(stripInternalMetadataForDisplay(replayContent));
	const trimmed = strippedText.trim();
	if (!trimmed) return null;
	return {
		...message,
		content: [{
			type: "text",
			text: strippedText
		}]
	};
}`;

const NORMALIZE_BLOCK_OLD = `function normalizeAssistantReplayBlockContent(message, replayContent) {
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
}`;

const NORMALIZE_BLOCK_NEW = `function normalizeAssistantReplayBlockContent(message, replayContent) {
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
		const strippedText = sanitizeAssistantReplayVisibleText(stripInternalMetadataForDisplay(text));
		if (strippedText === text) {
			if (strippedText.trim()) sanitizedContent.push(block);
			else touched = true;
			continue;
		}
		touched = true;
		if (strippedText.trim()) sanitizedContent.push({
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
}`;

const GUARDED_APPEND_OLD = `\t\tconst finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
\t\tif (!finalMessage) return;
\t\tconst finalRole = finalMessage.role;`;

const GUARDED_APPEND_NEW = `\t\tlet finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
\t\tif (!finalMessage) return;
\t\tif (finalMessage.role === "assistant") {
\t\t\tconst sanitizedAssistant = sanitizeAssistantMessageForTranscriptPersistence(finalMessage);
\t\t\tif (!sanitizedAssistant) return;
\t\t\tfinalMessage = sanitizedAssistant;
\t\t}
\t\tconst finalRole = finalMessage.role;`;

export function hasOpenClawSilentReplyPatches(source) {
  return source.includes(SILENT_REPLY_PATCH_MARKER);
}

export function applyOpenClawSilentReplyPatches(source) {
  if (!source.includes('function normalizeAssistantReplayTextContent(message, replayContent)')) {
    return { source, patched: false };
  }
  if (hasOpenClawSilentReplyPatches(source)) {
    return { source, patched: false };
  }

  let patched = false;
  let next = source;

  if (TOKENS_IMPORT_PATCH_OLD.test(next) && !next.includes('c as stripSilentToken')) {
    next = next.replace(TOKENS_IMPORT_PATCH_OLD, (match) => {
      if (match.includes('c as stripSilentToken')) return match;
      return match.replace(
        's as stripLeadingSilentToken } from',
        's as stripLeadingSilentToken, c as stripSilentToken } from',
      );
    });
    patched = true;
  }
  if (TOKENS_IMPORT_PATCH_65.test(next) && !next.includes('SILENT_REPLY_TOKEN')) {
    next = next.replace(TOKENS_IMPORT_PATCH_65, TOKENS_IMPORT_PATCH_REPLACEMENT);
    patched = true;
  }

  if (next.includes('function installSessionToolResultGuard(sessionManager, opts)')) {
    next = next.replace(
      'function installSessionToolResultGuard(sessionManager, opts) {',
      `${REPLAY_HELPER}\n${PERSISTENCE_HELPER}\nfunction installSessionToolResultGuard(sessionManager, opts) {`,
    );
    patched = true;
  }

  if (next.includes(NORMALIZE_TEXT_OLD)) {
    next = next.replace(NORMALIZE_TEXT_OLD, NORMALIZE_TEXT_NEW);
    patched = true;
  }

  if (next.includes(NORMALIZE_BLOCK_OLD)) {
    next = next.replace(NORMALIZE_BLOCK_OLD, NORMALIZE_BLOCK_NEW);
    patched = true;
  }

  if (next.includes(GUARDED_APPEND_OLD)) {
    next = next.replace(GUARDED_APPEND_OLD, GUARDED_APPEND_NEW);
    patched = true;
  }

  return { source: next, patched };
}
