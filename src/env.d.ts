// Build-time constants injected by tools/build.mjs.
declare const __VERSION__: string;
declare const __DEV__: boolean;

// Stylesheets are imported as minified text.
declare module '*.css' {
  const css: string;
  export default css;
}
