// Sucrase's tokenizer, used to find loops in compiled miniapp code. The package ships these
// types under dist/types but does not map them.
declare module 'sucrase/dist/parser' {
  export { parse } from 'sucrase/dist/types/parser/index';
}
declare module 'sucrase/dist/parser/tokenizer/types' {
  export { TokenType } from 'sucrase/dist/types/parser/tokenizer/types';
}
