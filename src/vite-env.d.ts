interface Window {
  ethereum?: any;
}

declare module 'https://cdn.zama.ai/relayer-sdk-js/0.2.0/relayer-sdk-js.js' {
  export function initSDK(): Promise<void>;
  export function createInstance(config: any): Promise<any>;
  export const SepoliaConfig: any;
}
