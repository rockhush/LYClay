export interface SendMessageOptions {
  /** One-turn OpenClaw skill allowlist (runtime skill names). */
  skillFilter?: string[];
  /** Gateway-bound message when it differs from the UI display text (e.g. skill @mention rewrite). */
  gatewayText?: string;
}
