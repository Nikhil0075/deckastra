// fontkit ships no types. Only `create` is used (`pdf-unicode.ts`), and what it
// returns is read through that module's own narrow `FontkitFont` shape.
declare module "fontkit" {
  export function create(buffer: Buffer | Uint8Array): unknown;
}
