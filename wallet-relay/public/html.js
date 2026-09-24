// @ts-check
import htm from './vendor/htm.module.js'
import { h, render } from './vendor/preact.module.js'

/**
 * Vendored rather than bundled: this page is served as the files you see, with no build step
 * between the source and the browser. `htm` is a tagged template, so there is no JSX to
 * compile — and interpolating a value escapes it, which on the screen that approves
 * transactions is the point.
 */
export const html = htm.bind(h)
export { render }
