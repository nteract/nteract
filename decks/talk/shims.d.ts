declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "virtual:isolated-renderer" {
  export const rendererCode: string;
  export const rendererCss: string;
}

declare module "virtual:renderer-plugin/*" {
  export const code: string;
  export const css: string;
}
