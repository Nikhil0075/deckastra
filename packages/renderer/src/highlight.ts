/**
 * Syntax highlighting (doc 04 §19.3).
 *
 * A hand-written scanner rather than a highlighting library, for the same reason
 * the icons are inlined: the renderer must produce identical output in the
 * browser, in Node and in the headless export service, with no network and no
 * asynchronous grammar loading. A highlighter that resolves a grammar lazily
 * renders unstyled on the first frame and styled on the second, which is a
 * visible flash in present mode and a diff in a snapshot test.
 *
 * It is deliberately shallow. This classifies comments, strings, numbers,
 * keywords and declaration names — the distinctions that make a code slide
 * readable from the back of a room. It is not a parser and does not try to be:
 * semantic highlighting on a slide is effort spent where nobody is looking.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "operator"
  | "punctuation";

export interface CodeToken {
  text: string;
  kind: TokenKind;
}

interface Grammar {
  lineComment?: string[];
  blockComment?: [string, string];
  /** Quote characters that start a string. */
  quotes: string[];
  /** Triple-quoted strings (Python). */
  tripleQuotes?: boolean;
  keywords: Set<string>;
  types: Set<string>;
  caseInsensitiveKeywords?: boolean;
}

const C_FAMILY_PUNCTUATION = new Set([..."{}[]()<>;,.:"]);
const OPERATOR_CHARS = new Set([..."+-*/%=!&|^~?"]);

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

const TYPESCRIPT: Grammar = {
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"],
  keywords: words(`
    abstract as async await break case catch class const continue declare default delete do else
    enum export extends finally for from function get if implements import in instanceof interface
    keyof let new of private protected public readonly return satisfies set static super switch this
    throw try type typeof var void while yield
  `),
  types: words(`
    any bigint boolean never null number object string symbol undefined unknown Array Map Set Promise
    Record Partial Readonly true false
  `),
};

const PYTHON: Grammar = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  tripleQuotes: true,
  keywords: words(`
    and as assert async await break class continue def del elif else except finally for from global
    if import in is lambda match nonlocal not or pass raise return try while with yield
  `),
  types: words(`
    None True False int float str bool bytes list dict set tuple Any Optional Union Callable self cls
  `),
};

const SQL: Grammar = {
  lineComment: ["--"],
  blockComment: ["/*", "*/"],
  quotes: ["'", '"'],
  caseInsensitiveKeywords: true,
  keywords: words(`
    select from where group by having order limit offset insert into values update set delete create
    table alter drop index view join left right inner outer full on as and or not null distinct union
    all with returning primary key foreign references default constraint cascade
  `),
  types: words(`
    int integer bigint smallint serial text varchar char boolean bool date timestamp timestamptz
    numeric decimal real double jsonb json uuid array
  `),
};

const SHELL: Grammar = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  keywords: words(`
    if then else elif fi for while do done case esac function return export local readonly set unset
    source echo cd exit trap shift
  `),
  types: words("true false"),
};

const GO: Grammar = {
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "`", "'"],
  keywords: words(`
    break case chan const continue default defer else fallthrough for func go goto if import
    interface map package range return select struct switch type var
  `),
  types: words(`
    bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint
    uint8 uint16 uint32 uint64 uintptr nil true false
  `),
};

const RUST: Grammar = {
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  keywords: words(`
    as async await break const continue crate dyn else enum extern fn for if impl in let loop match
    mod move mut pub ref return self Self static struct super trait type unsafe use where while
  `),
  types: words(`
    bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize Vec Option
    Result Box true false None Some Ok Err
  `),
};

const JSON_GRAMMAR: Grammar = {
  quotes: ['"'],
  keywords: words("true false null"),
  types: new Set(),
};

const YAML: Grammar = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  keywords: words("true false null yes no on off"),
  types: new Set(),
};

const GRAMMARS: Record<string, Grammar> = {
  typescript: TYPESCRIPT,
  ts: TYPESCRIPT,
  tsx: TYPESCRIPT,
  javascript: TYPESCRIPT,
  js: TYPESCRIPT,
  jsx: TYPESCRIPT,
  json: JSON_GRAMMAR,
  python: PYTHON,
  py: PYTHON,
  sql: SQL,
  postgresql: SQL,
  bash: SHELL,
  sh: SHELL,
  shell: SHELL,
  zsh: SHELL,
  go: GO,
  golang: GO,
  rust: RUST,
  rs: RUST,
  yaml: YAML,
  yml: YAML,
};

export const HIGHLIGHTED_LANGUAGES = [...new Set(Object.keys(GRAMMARS))].sort();

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Tokenize one source string.
 *
 * Single pass, character by character, with no backtracking — the input is
 * user-supplied and a regex-based scanner with nested quantifiers is a
 * denial-of-service waiting for the right code block.
 *
 * Unknown languages return one plain token. That is the honest answer: guessing
 * a grammar produces confidently wrong colours, which is worse than none.
 */
export function highlight(code: string, language: string): CodeToken[] {
  const grammar = GRAMMARS[language.trim().toLowerCase()];
  if (!grammar) return code === "" ? [] : [{ text: code, kind: "plain" }];

  const tokens: CodeToken[] = [];
  let plain = "";

  const flush = (): void => {
    if (plain !== "") {
      tokens.push({ text: plain, kind: "plain" });
      plain = "";
    }
  };

  const push = (text: string, kind: TokenKind): void => {
    flush();
    tokens.push({ text, kind });
  };

  let i = 0;

  while (i < code.length) {
    const char = code[i]!;
    const rest = code.slice(i);

    // ---------------------------------------------------------- comments
    const lineMarker = grammar.lineComment?.find((marker) => rest.startsWith(marker));
    if (lineMarker) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    if (grammar.blockComment && rest.startsWith(grammar.blockComment[0])) {
      const close = code.indexOf(grammar.blockComment[1], i + grammar.blockComment[0].length);
      // An unterminated block comment runs to the end of the file — which is what
      // the compiler would do too.
      const stop = close === -1 ? code.length : close + grammar.blockComment[1].length;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }

    // ----------------------------------------------------------- strings
    if (grammar.tripleQuotes && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const marker = rest.slice(0, 3);
      const close = code.indexOf(marker, i + 3);
      const stop = close === -1 ? code.length : close + 3;
      push(code.slice(i, stop), "string");
      i = stop;
      continue;
    }

    if (grammar.quotes.includes(char)) {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === char) {
          j += 1;
          break;
        }
        // A single-quoted string does not span lines in any of these grammars;
        // stopping at the newline keeps one unbalanced quote from painting the
        // rest of the slide as a string.
        if (code[j] === "\n" && char !== "`") break;
        j += 1;
      }
      push(code.slice(i, j), "string");
      i = j;
      continue;
    }

    // ----------------------------------------------------------- numbers
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i;
      while (j < code.length && /[0-9a-fA-FxXoObB_.eE+-]/.test(code[j]!)) {
        // `+`/`-` only continue a number as an exponent sign.
        if ((code[j] === "+" || code[j] === "-") && !/[eE]/.test(code[j - 1] ?? "")) break;
        j += 1;
      }
      push(code.slice(i, j), "number");
      i = j;
      continue;
    }

    // ------------------------------------------------------- identifiers
    if (isIdentifierStart(char)) {
      let j = i;
      while (j < code.length && isIdentifierPart(code[j]!)) j += 1;
      const word = code.slice(i, j);
      const lookup = grammar.caseInsensitiveKeywords ? word.toLowerCase() : word;

      if (grammar.keywords.has(lookup)) push(word, "keyword");
      else if (grammar.types.has(lookup)) push(word, "type");
      else if (code[j] === "(") push(word, "function");
      else plain += word;

      i = j;
      continue;
    }

    if (C_FAMILY_PUNCTUATION.has(char)) {
      push(char, "punctuation");
      i += 1;
      continue;
    }

    if (OPERATOR_CHARS.has(char)) {
      let j = i;
      while (j < code.length && OPERATOR_CHARS.has(code[j]!)) j += 1;
      push(code.slice(i, j), "operator");
      i = j;
      continue;
    }

    plain += char;
    i += 1;
  }

  flush();
  return tokens;
}

/**
 * Token colours, derived from the theme rather than from a hardcoded scheme.
 *
 * A code block that ignores the deck's palette is the one element on the slide
 * that looks pasted in. Deriving from `chartSeries` is deliberate: those colours
 * are already guaranteed to be distinguishable from each other and legible on
 * the deck's surface, which is exactly the property a syntax scheme needs.
 */
export interface CodeColors {
  plain: string;
  comment: string;
  string: string;
  number: string;
  keyword: string;
  type: string;
  function: string;
  operator: string;
  punctuation: string;
}

export function codeColors(
  foreground: string,
  muted: string,
  series: readonly string[],
): CodeColors {
  return {
    plain: foreground,
    comment: muted,
    string: series[2] ?? foreground,
    number: series[3] ?? foreground,
    keyword: series[0] ?? foreground,
    type: series[1] ?? foreground,
    function: series[4] ?? foreground,
    operator: muted,
    punctuation: muted,
  };
}
