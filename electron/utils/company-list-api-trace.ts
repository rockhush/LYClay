let lastCompanyListApiUrl: string | null = null;
let lastCompanyListApiResponse: unknown = null;

export function setLastCompanyListApiTrace(url: string, response: unknown): void {
  lastCompanyListApiUrl = url;
  lastCompanyListApiResponse = response;
}

export function getLastCompanyListApiTrace(): {
  url: string | null;
  response: unknown;
} {
  return {
    url: lastCompanyListApiUrl,
    response: lastCompanyListApiResponse,
  };
}
