/** Anonymous access is limited to the documented public endpoints. */
export function isAnySearchKeylessEndpoint(value: string): boolean {
  return matches(value, 'https://api.anysearch.com', ['/v1/search', '/v1/extract']);
}

export function isTavilyKeylessEndpoint(value: string): boolean {
  return matches(value, 'https://api.tavily.com', ['/search', '/extract']);
}

function matches(value: string, origin: string, paths: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && paths.includes(url.pathname);
  } catch { return false; }
}
