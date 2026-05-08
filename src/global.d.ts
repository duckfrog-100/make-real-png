declare const React: {
  createElement: (...args: any[]) => any;
  StrictMode: (props: { children?: any }) => any;
  useMemo: <T>(factory: () => T, deps: any[]) => T;
  useState: <T>(initialState: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void];
};

declare const ReactDOM: {
  createRoot: (container: Element | DocumentFragment) => { render: (children: any) => void };
};

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
