let hostApiToken = '';
let commandPolicyPreflightToken = '';

export function setHostApiToken(token: string): void {
  hostApiToken = token;
}

export function getHostApiToken(): string {
  return hostApiToken;
}

export function setCommandPolicyPreflightToken(token: string): void {
  commandPolicyPreflightToken = token;
}

export function getCommandPolicyPreflightToken(): string {
  return commandPolicyPreflightToken;
}
