// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Regex pattern parser (compile-time, pure TypeScript).
 *
 * Recursive-descent parser for the Phase-2a subset of ECMAScript regular
 * expressions (ES2024 §22.2.1). Produces a small AST consumed by
 * `compile.ts`. Anything outside the subset throws `RegexUnsupportedError`,
 * which the codegen entry points turn into a clean #1539-phased compile error
 * (the "narrowed refusal" the architect requires).
 *
 * Supported in 2a:
 *   - literal code units, `.`
 *   - char classes `[...]` / `[^...]` with ranges and `\d \D \w \W \s \S`
 *   - escapes `\n \r \t \f \v \0`, `\xHH`, `\uHHHH`, escaped metacharacters
 *   - anchors `^` `$`
 *   - quantifiers `* + ?` and `{n}` `{n,}` `{n,m}`, optional lazy `?` suffix
 *   - alternation `|`
 *   - groups `(…)` capturing, `(?:…)` non-capturing, `(?<name>…)` named
 *
 * Refused in 2a (each cites the phase that adds it):
 *   - backreferences `\1` / `\k<name>`            → 2b
 *   - lookahead/lookbehind `(?=) (?!) (?<=) (?<!)` → 2d
 *   - Unicode property escapes `\p{…}` / `\P{…}`   → 2d
 *   - the `u`/`v` flags' code-point semantics      → 2c/2d (parse still UTF-16)
 */
import { RegexUnsupportedError } from "./bytecode.js";

export type ReNode =
  | { kind: "char"; code: number }
  | { kind: "any" }
  | { kind: "class"; ranges: Array<[number, number]>; negated: boolean }
  | { kind: "bol" }
  | { kind: "eol" }
  | { kind: "concat"; parts: ReNode[] }
  | { kind: "alt"; options: ReNode[] }
  | { kind: "star"; node: ReNode; greedy: boolean }
  | { kind: "plus"; node: ReNode; greedy: boolean }
  | { kind: "opt"; node: ReNode; greedy: boolean }
  | { kind: "repeat"; node: ReNode; min: number; max: number; greedy: boolean } // max=-1 => unbounded
  | { kind: "group"; node: ReNode; capIndex: number; name: string | null }; // capIndex<0 => non-capturing

export interface ParsedRegex {
  root: ReNode;
  /** Number of capturing groups (group 0 / whole match NOT included). */
  numCaptures: number;
  /** Capture name → 1-based group index for named groups. */
  groupNames: Map<string, number>;
}

const DIGIT: Array<[number, number]> = [[0x30, 0x39]];
const WORD: Array<[number, number]> = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
// \s per §22.2.2.1: \t \n \v \f \r space      -
//
const SPACE: Array<[number, number]> = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

class Parser {
  private pos = 0;
  numCaptures = 0;
  readonly groupNames = new Map<string, number>();

  constructor(private readonly src: string) {}

  private peek(): string | undefined {
    return this.src[this.pos];
  }
  private next(): string {
    const c = this.src[this.pos];
    if (c === undefined) throw new RegexUnsupportedError("unexpected end of pattern");
    this.pos++;
    return c;
  }
  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  parse(): ReNode {
    const node = this.parseAlternation();
    if (!this.eof()) {
      // A stray ) or other leftover — surface as unsupported rather than wrong.
      throw new RegexUnsupportedError(`unexpected '${this.peek()}' at index ${this.pos}`);
    }
    return node;
  }

  private parseAlternation(): ReNode {
    const options: ReNode[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.next();
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  private parseConcat(): ReNode {
    const parts: ReNode[] = [];
    while (!this.eof() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) return { kind: "concat", parts: [] };
    return parts.length === 1 ? parts[0]! : { kind: "concat", parts };
  }

  private parseQuantified(): ReNode {
    const atom = this.parseAtom();
    const c = this.peek();
    if (c === "*" || c === "+" || c === "?") {
      this.next();
      const greedy = this.consumeLazy();
      if (c === "*") return { kind: "star", node: atom, greedy };
      if (c === "+") return { kind: "plus", node: atom, greedy };
      return { kind: "opt", node: atom, greedy };
    }
    if (c === "{") {
      const saved = this.pos;
      const bounds = this.tryParseBraceQuantifier();
      if (bounds) {
        const greedy = this.consumeLazy();
        return { kind: "repeat", node: atom, min: bounds[0], max: bounds[1], greedy };
      }
      // Not a valid quantifier — treat `{` as a literal (Annex B). Rewind.
      this.pos = saved;
    }
    return atom;
  }

  private consumeLazy(): boolean {
    if (this.peek() === "?") {
      this.next();
      return false; // lazy
    }
    return true; // greedy
  }

  /** Returns [min,max] (max=-1 unbounded) or null if not a `{n}`/`{n,}`/`{n,m}`. */
  private tryParseBraceQuantifier(): [number, number] | null {
    if (this.peek() !== "{") return null;
    this.next();
    let minStr = "";
    while (this.peek() !== undefined && /[0-9]/.test(this.peek()!)) minStr += this.next();
    if (minStr === "") return null;
    const min = parseInt(minStr, 10);
    let max = min;
    if (this.peek() === ",") {
      this.next();
      let maxStr = "";
      while (this.peek() !== undefined && /[0-9]/.test(this.peek()!)) maxStr += this.next();
      max = maxStr === "" ? -1 : parseInt(maxStr, 10);
    }
    if (this.peek() !== "}") return null;
    this.next();
    if (max !== -1 && max < min) throw new RegexUnsupportedError("quantifier max < min");
    return [min, max];
  }

  private parseAtom(): ReNode {
    const c = this.peek();
    if (c === undefined) throw new RegexUnsupportedError("unexpected end of pattern");
    if (c === "(") return this.parseGroup();
    if (c === "[") return this.parseClass();
    if (c === ".") {
      this.next();
      return { kind: "any" };
    }
    if (c === "^") {
      this.next();
      return { kind: "bol" };
    }
    if (c === "$") {
      this.next();
      return { kind: "eol" };
    }
    if (c === "\\") return this.parseEscapeAtom();
    if (c === "*" || c === "+" || c === "?") {
      throw new RegexUnsupportedError(`nothing to repeat at index ${this.pos}`);
    }
    // ordinary literal code unit
    this.next();
    return { kind: "char", code: c.charCodeAt(0) };
  }

  private parseGroup(): ReNode {
    this.next(); // consume "("
    let capIndex = -1;
    let name: string | null = null;
    if (this.peek() === "?") {
      this.next();
      const t = this.peek();
      if (t === ":") {
        this.next(); // non-capturing
      } else if (t === "<") {
        this.next();
        const after = this.peek();
        if (after === "=" || after === "!") {
          throw new RegexUnsupportedError("lookbehind (?<= / ?<!) — #1539 Phase 2d");
        }
        // named capture (?<name>…)
        name = "";
        while (this.peek() !== ">" && !this.eof()) name += this.next();
        if (this.peek() !== ">") throw new RegexUnsupportedError("unterminated group name");
        this.next();
        capIndex = ++this.numCaptures;
        if (this.groupNames.has(name)) {
          throw new RegexUnsupportedError(`duplicate capture group name '${name}'`);
        }
        this.groupNames.set(name, capIndex);
      } else if (t === "=" || t === "!") {
        throw new RegexUnsupportedError("lookahead (?= / ?!) — #1539 Phase 2d");
      } else {
        throw new RegexUnsupportedError(`unsupported group form '(?${t ?? ""}' — #1539 Phase 2d`);
      }
    } else {
      capIndex = ++this.numCaptures;
    }
    const inner = this.parseAlternation();
    if (this.peek() !== ")") throw new RegexUnsupportedError("unterminated group");
    this.next();
    return { kind: "group", node: inner, capIndex, name };
  }

  private parseEscapeAtom(): ReNode {
    this.next(); // consume "\"
    const e = this.peek();
    if (e === undefined) throw new RegexUnsupportedError("trailing escape");
    // Class shorthands as standalone atoms.
    if (e === "d") {
      this.next();
      return { kind: "class", ranges: DIGIT, negated: false };
    }
    if (e === "D") {
      this.next();
      return { kind: "class", ranges: DIGIT, negated: true };
    }
    if (e === "w") {
      this.next();
      return { kind: "class", ranges: WORD, negated: false };
    }
    if (e === "W") {
      this.next();
      return { kind: "class", ranges: WORD, negated: true };
    }
    if (e === "s") {
      this.next();
      return { kind: "class", ranges: SPACE, negated: false };
    }
    if (e === "S") {
      this.next();
      return { kind: "class", ranges: SPACE, negated: true };
    }
    if (e === "b" || e === "B") {
      throw new RegexUnsupportedError(`word-boundary \\${e} — #1539 Phase 2b`);
    }
    if (e >= "1" && e <= "9") {
      throw new RegexUnsupportedError(`backreference \\${e} — #1539 Phase 2b`);
    }
    if (e === "k") {
      throw new RegexUnsupportedError("named backreference \\k — #1539 Phase 2b");
    }
    if (e === "p" || e === "P") {
      throw new RegexUnsupportedError(`Unicode property escape \\${e}{…} — #1539 Phase 2d`);
    }
    return { kind: "char", code: this.parseEscapedCodeUnit() };
  }

  /** Parse the code unit denoted by an escape, with the backslash already
   *  consumed. Shared by atom and class parsing for non-class-shorthand
   *  escapes. */
  private parseEscapedCodeUnit(): number {
    const e = this.next();
    switch (e) {
      case "n":
        return 0x0a;
      case "r":
        return 0x0d;
      case "t":
        return 0x09;
      case "f":
        return 0x0c;
      case "v":
        return 0x0b;
      case "0":
        return 0x00;
      case "x": {
        const hex = this.next() + this.next();
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new RegexUnsupportedError(`bad \\x escape`);
        return parseInt(hex, 16);
      }
      case "u": {
        if (this.peek() === "{") throw new RegexUnsupportedError("\\u{…} code-point escape — #1539 Phase 2c/2d");
        const hex = this.next() + this.next() + this.next() + this.next();
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new RegexUnsupportedError(`bad \\u escape`);
        return parseInt(hex, 16);
      }
      default:
        // Escaped metacharacter or escaped literal — the char itself.
        return e.charCodeAt(0);
    }
  }

  private parseClass(): ReNode {
    this.next(); // consume "["
    let negated = false;
    if (this.peek() === "^") {
      this.next();
      negated = true;
    }
    const ranges: Array<[number, number]> = [];
    while (!this.eof() && this.peek() !== "]") {
      // Parse one class member: a code unit or a shorthand class.
      const member = this.parseClassMember();
      if (member.kind === "shorthand") {
        for (const r of member.ranges) ranges.push([r[0], r[1]]);
        continue;
      }
      const lo = member.code;
      // Range? `a-z`, but a trailing `-` (e.g. `[a-]`) is a literal `-`.
      if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.src[this.pos + 1] !== undefined) {
        this.next(); // consume "-"
        const hiMember = this.parseClassMember();
        if (hiMember.kind === "shorthand") {
          throw new RegexUnsupportedError("class shorthand as range endpoint");
        }
        const hi = hiMember.code;
        if (hi < lo) throw new RegexUnsupportedError("class range out of order");
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (this.peek() !== "]") throw new RegexUnsupportedError("unterminated character class");
    this.next();
    return { kind: "class", ranges, negated };
  }

  private parseClassMember(): { kind: "char"; code: number } | { kind: "shorthand"; ranges: Array<[number, number]> } {
    if (this.peek() === "\\") {
      this.next();
      const e = this.peek();
      if (e === "d") {
        this.next();
        return { kind: "shorthand", ranges: DIGIT };
      }
      if (e === "w") {
        this.next();
        return { kind: "shorthand", ranges: WORD };
      }
      if (e === "s") {
        this.next();
        return { kind: "shorthand", ranges: SPACE };
      }
      // Negated shorthands inside a class need set complement — defer to 2b.
      if (e === "D" || e === "W" || e === "S") {
        throw new RegexUnsupportedError(`negated shorthand \\${e} inside [...] — #1539 Phase 2b`);
      }
      if (e === "b") {
        this.next();
        return { kind: "char", code: 0x08 };
      } // \b is backspace in a class
      if (e === "p" || e === "P") {
        throw new RegexUnsupportedError(`Unicode property escape \\${e}{…} — #1539 Phase 2d`);
      }
      return { kind: "char", code: this.parseEscapedCodeUnit() };
    }
    return { kind: "char", code: this.next().charCodeAt(0) };
  }
}

export function parsePattern(pattern: string): ParsedRegex {
  const p = new Parser(pattern);
  const root = p.parse();
  return { root, numCaptures: p.numCaptures, groupNames: p.groupNames };
}
