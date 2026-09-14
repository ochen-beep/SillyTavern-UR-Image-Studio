/**
 * Fake router that records registered route handlers.
 * Used by tests to verify route registration.
 */
export function createFakeRouter() {
  const routes = [];

  const router = {
    get(path, ...handlers) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: 'POST', path, handlers });
    },
    put(path, ...handlers) {
      routes.push({ method: 'PUT', path, handlers });
    },
    delete(path, ...handlers) {
      routes.push({ method: 'DELETE', path, handlers });
    },
  };

  return { router, routes };
}
