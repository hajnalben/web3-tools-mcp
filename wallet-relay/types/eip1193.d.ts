/**
 * What a browser wallet puts on the page.
 *
 * Kept out of `public/` deliberately: everything in there is served to the browser, and a
 * type declaration is for the checker alone.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<any>
  on?(event: string, handler: (...args: any[]) => void): void
  removeListener?(event: string, handler: (...args: any[]) => void): void
  isMetaMask?: boolean
  isRabby?: boolean
  /** Several extensions installed at once; each announces itself here. */
  providers?: Eip1193Provider[]
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
    rabby?: Eip1193Provider
  }
}
