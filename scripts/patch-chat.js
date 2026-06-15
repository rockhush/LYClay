const fs = require("fs");
const p = "D:/lycode/lyclaw/src/stores/chat.ts";
let src = fs.readFileSync(p, "utf-8");
const lines = src.split("\n");

let funcStart = -1, trimmedLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("targetAgentId?: string | null") && (lines[i+1]||"").trim() === ") => {") funcStart = i;
  if (funcStart > 0 && funcStart < i && (lines[i]||"").trim() === "const trimmed = text.trim();") { trimmedLine = i; break; }
}
const indent = (lines[trimmedLine]||"").match(/^(\s*)/)[1];
const sp = (s) => indent + s;
src = src.replace(
  lines[funcStart+1].trimEnd() + "\n",
  lines[funcStart+1].trimEnd() + "\n" + [
    sp("let _deIsDigital = false;"),
    sp("let _deAgentId = targetAgentId;"),
    sp("if (targetAgentId) {"),
    sp("  try {"),
    sp('    const checkResult = await hostApiFetch<{ success: boolean; isDigitalEmployee: boolean }>('),
    sp('      `/api/agents/is-digital-employee?agentId=${encodeURIComponent(targetAgentId)}`'),
    sp("    );"),
    sp("    if (checkResult.success && checkResult.isDigitalEmployee) {"),
    sp("      _deIsDigital = true;"),
    sp("      _deAgentId = null;"),
    sp("    }"),
    sp("  } catch { /* fall through */ }"),
    sp("}"),
  ].join("\n") + "\n"
);
src = src.replace("resolveMainSessionKeyForAgent(targetAgentId)", "resolveMainSessionKeyForAgent(_deAgentId)");

// extraSystemPrompt snippet - identical for both paths
const esp = '\n          ...(_deIsDigital ? { extraSystemPrompt: "Use sessions_spawn immediately. agentId=" + JSON.stringify(targetAgentId) + ". task=" + JSON.stringify(runtimeMessage) + ". Do not reply, call the tool." } : {}),';

// Find chatSendParams block
const csIdx = src.indexOf("const chatSendParams: Record<string, unknown> = {");
if (csIdx > 0) {
  const idemIdx = src.indexOf("idempotencyKey,", csIdx);
  const closeIdx = src.indexOf("\n        };", idemIdx);
  if (closeIdx > 0) {
    src = src.substring(0, closeIdx) + esp + src.substring(closeIdx);
    console.log("Step 3 OK (chatSendParams)");
  } else console.log("Step 3 FAILED (no close)");
} else console.log("Step 3 FAILED (no start)");

// Find media path - second occurrence of "idempotencyKey," after send-with-media context
const mediaCtx = src.indexOf("/api/chat/send-with-media");
if (mediaCtx > 0) {
  let idemIdx2 = src.indexOf("idempotencyKey,", mediaCtx);
  let mediaIdx = src.indexOf("media:", idemIdx2);
  if (idemIdx2 > 0 && mediaIdx > idemIdx2 && mediaIdx - idemIdx2 < 200) {
    src = src.substring(0, mediaIdx - 1) + esp + "\n              " + src.substring(mediaIdx - 1);
    console.log("Step 4 OK (media path)");
  } else console.log("Step 4 FAILED (no media field)");
} else console.log("Step 4 FAILED (no send-with-media)");

fs.writeFileSync(p, src, "utf-8");
console.log("Done.");
