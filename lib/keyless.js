/** Anonymous access is limited to the documented public endpoints. */
export function isAnySearchKeylessEndpoint(value) {
    return matches(value, 'https://api.anysearch.com', ['/v1/search', '/v1/extract']);
}
export function isTavilyKeylessEndpoint(value) {
    return matches(value, 'https://api.tavily.com', ['/search', '/extract']);
}
function matches(value, origin, paths) {
    try {
        const url = new URL(value);
        return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && paths.includes(url.pathname);
    }
    catch {
        return false;
    }
}
