export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:/@]+):([^@]+)@/, '://***:***@');
  }
}

export function requireUrl(url?: string): string {
  if (!url) {
    throw new Error('Missing required --url <postgres-url>.');
  }
  return url;
}
