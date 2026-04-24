// `generated/api` exports zod schemas (consts) and `generated/types` exports
// TypeScript interfaces with the same names for body/response shapes
// (LoginBody, CreateAreaBody, ...). Re-exporting both makes `tsc --build`
// fail with TS2308 ambiguity. Today nothing in the workspace imports types
// from this package — consumers want the zod runtime schemas — so we only
// re-export the schemas. Types are still reachable via deep import
// (`@workspace/api-zod/dist/generated/types/...`) if ever needed.
export * from "./generated/api";
