export function parseCookies(cookieHeader?: string | string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!header || typeof header !== 'string') return cookies;

  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  });

  return cookies;
}
