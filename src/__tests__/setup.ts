import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement scrollIntoView; components that keep a highlighted
// row in view (e.g. the command palette) call it, so stub it to a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
