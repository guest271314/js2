// Focused public-API assertions transcribed from the named tests in React's
// pinned v19.2.6 source. They run against the exact published production
// implementation, not a reimplementation. Each body is evaluated both
// natively and after compiling the same implementation plus a Wasm wrapper.

const createElementTest = "packages/react/src/__tests__/ReactCreateElement-test.js";
const cloneTest = "packages/react/src/__tests__/ReactElementClone-test.js";

export const REACT_UPSTREAM_VECTORS = [
  {
    name: "string_type",
    sourceFile: createElementTest,
    sourceTest: "allows a string to be passed as the type",
    body: `
      const element = REACT.createElement("div");
      return element.type === "div" && element.key === null && element.ref === null && Object.keys(element.props).length === 0 ? 1 : 0;
    `,
  },
  {
    name: "extract_key",
    sourceFile: createElementTest,
    sourceTest: "extracts key from the rest of the props",
    body: `
      const element = REACT.createElement("div", { key: "12", foo: "56" });
      return element.key === "12" && element.props.foo === "56" && !("key" in element.props) ? 1 : 0;
    `,
  },
  {
    name: "coerce_key",
    sourceFile: createElementTest,
    sourceTest: "coerces the key to a string",
    body: `
      const element = REACT.createElement("div", { key: 12, foo: "56" });
      return element.key === "12" && element.props.foo === "56" ? 1 : 0;
    `,
  },
  {
    name: "child_argument",
    sourceFile: createElementTest,
    sourceTest: "merges an additional argument onto the children prop",
    body: `
      const element = REACT.createElement("div", { children: "text" }, 1);
      return element.props.children === 1 ? 1 : 0;
    `,
  },
  {
    name: "clone_new_props",
    sourceFile: cloneTest,
    sourceTest: "should clone a DOM component with new props",
    body: `
      const element = REACT.createElement("span", { key: "before", className: "old" });
      const clone = REACT.cloneElement(element, { key: "after", className: "new" });
      return clone.type === "span" && clone.key === "after" && clone.props.className === "new" ? 1 : 0;
    `,
  },
];

export function buildReactUpstreamDriver() {
  return REACT_UPSTREAM_VECTORS.map(
    (vector) => `export function ${vector.name}() {${vector.body.replaceAll("REACT", "exports")}}`,
  ).join("\n");
}
