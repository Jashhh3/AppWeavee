export class AppWeaveRequestError extends Error {
    details;
    status;
    constructor(details, status) {
        super(details.message);
        this.details = details;
        this.status = status;
        this.name = 'AppWeaveRequestError';
    }
}
export function createAppWeaveClient(options) {
    const base = options.baseUrl.replace(/\/$/, '');
    let token = options.token;
    async function call(path, init = {}) { const response = await fetch(`${base}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-appweave-client-id': options.publicClientId, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok)
        throw new AppWeaveRequestError(body.error ?? { code: 'REQUEST_FAILED', message: 'Request failed' }, response.status); return body; }
    return { setToken(value) { token = value; }, register(email, password) { return call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }); }, login(email, password) { return call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); }, projects() { return call('/projects'); }, products(projectId) { return call(`/projects/${projectId}/products`); }, createProduct(projectId, product) { return call(`/projects/${projectId}/products`, { method: 'POST', body: JSON.stringify(product) }); }, api(path, init) { return call(path, init); } };
}
