import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement scrollIntoView; components that keep a highlighted
// row in view (e.g. the command palette) call it, so stub it to a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// The test runtime exposes a non-functional native `localStorage` (its
// getItem/setItem/clear are missing), so features that persist to it — like the
// ThemeProvider — can't run. Replace it with a small in-memory Storage.
{
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
  });
}

// jsdom doesn't implement matchMedia; the ThemeProvider reads it to resolve the
// system appearance and to subscribe to OS-level changes. Stub a light-mode,
// no-op media query so components under test can mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
