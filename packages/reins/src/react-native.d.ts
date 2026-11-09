// Minimal types for the parts of react-native this package uses, so it builds without react-native installed.
declare module 'react-native' {
  export const NativeModules: { SourceCode?: { scriptURL?: string } };
  export const Platform: { OS: string };
  export const PixelRatio: { get(): number };
  export const View: any;
}
