/**
 * The signing requests waiting for an answer.
 *
 * Its own module, and free of any DOM, because the one thing this page must never get wrong
 * is *which* request a click answers. That used to be a single slot, so a second request
 * overwrote the first and the first was never answered at all — the agent waited on a
 * signature nobody could see. Anything here can be tested without a browser.
 */
export function requestQueue() {
  let items = []

  return {
    /** A copy: the only way in or out is through add and claim. */
    list: () => [...items],

    get size() {
      return items.length
    },

    add(request) {
      items = [...items, request]
      return items
    },

    /**
     * Take a request out, by id, so it can be answered.
     *
     * Removing it here rather than after the wallet replies is deliberate: approving opens a
     * wallet dialog that takes as long as it takes, and a second click in the meantime would
     * otherwise send the same transaction twice. A request already claimed returns null.
     */
    claim(id) {
      const found = items.find((request) => request.id === id)
      if (!found) return null
      items = items.filter((request) => request.id !== id)
      return found
    }
  }
}
