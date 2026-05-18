declare module "*.html?raw" {
  const content: string;
  export default content;
}

declare module "*.css?raw" {
  const content: string;
  export default content;
}

declare module "*.js?raw" {
  const content: string;
  export default content;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
