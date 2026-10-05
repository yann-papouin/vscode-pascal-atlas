import { PascalIntrinsic, PascalKeyword } from "./shared/pascal"
const PASCAL_KEYWORDS = new Set<string>([
  PascalKeyword.And,
  PascalKeyword.Array,
  PascalKeyword.As,
  PascalKeyword.Asm,
  PascalKeyword.Begin,
  PascalKeyword.Case,
  PascalKeyword.Class,
  PascalKeyword.Const,
  PascalKeyword.Constructor,
  PascalKeyword.Destructor,
  PascalKeyword.Dispinterface,
  PascalKeyword.Div,
  PascalKeyword.Do,
  PascalKeyword.Downto,
  PascalKeyword.Else,
  PascalKeyword.End,
  PascalKeyword.Except,
  PascalKeyword.Exports,
  PascalKeyword.File,
  PascalKeyword.Finalization,
  PascalKeyword.Finally,
  PascalKeyword.For,
  PascalKeyword.Function,
  PascalKeyword.Goto,
  PascalKeyword.If,
  PascalKeyword.Implementation,
  PascalKeyword.In,
  PascalKeyword.Inherited,
  PascalKeyword.Initialization,
  PascalKeyword.Inline,
  PascalKeyword.Interface,
  PascalKeyword.Is,
  PascalKeyword.Label,
  PascalKeyword.Library,
  PascalKeyword.Mod,
  PascalKeyword.Nil,
  PascalKeyword.Not,
  PascalKeyword.Object,
  PascalKeyword.Of,
  PascalKeyword.Or,
  PascalKeyword.Out,
  PascalKeyword.Packed,
  PascalKeyword.Procedure,
  PascalKeyword.Program,
  PascalKeyword.Property,
  PascalKeyword.Raise,
  PascalKeyword.Record,
  PascalKeyword.Repeat,
  PascalKeyword.Resourcestring,
  PascalKeyword.Set,
  PascalKeyword.Shl,
  PascalKeyword.Shr,
  PascalKeyword.String,
  PascalKeyword.Then,
  PascalKeyword.Threadvar,
  PascalKeyword.To,
  PascalKeyword.Try,
  PascalKeyword.Type,
  PascalKeyword.Unit,
  PascalKeyword.Until,
  PascalKeyword.Uses,
  PascalKeyword.Var,
  PascalKeyword.While,
  PascalKeyword.With,
  PascalKeyword.Xor,
])

const PASCAL_INTRINSIC_TYPE_IDENTIFIERS = new Set<string>([
  PascalIntrinsic.Ansichar,
  PascalIntrinsic.Ansistring,
  PascalIntrinsic.Boolean,
  PascalIntrinsic.Byte,
  PascalIntrinsic.Bytebool,
  PascalIntrinsic.Cardinal,
  PascalIntrinsic.Char,
  PascalIntrinsic.Comp,
  PascalIntrinsic.Currency,
  PascalIntrinsic.Double,
  PascalIntrinsic.Extended,
  PascalIntrinsic.Int8,
  PascalIntrinsic.Int16,
  PascalIntrinsic.Int32,
  PascalIntrinsic.Int64,
  PascalIntrinsic.Integer,
  PascalIntrinsic.Intptr,
  PascalIntrinsic.Longbool,
  PascalIntrinsic.Longint,
  PascalIntrinsic.Longword,
  PascalIntrinsic.Nativeint,
  PascalIntrinsic.Nativeuint,
  PascalIntrinsic.Olevariant,
  PascalIntrinsic.Pansichar,
  PascalIntrinsic.Pchar,
  PascalIntrinsic.Pointer,
  PascalIntrinsic.Pwidechar,
  PascalIntrinsic.Rawbytestring,
  PascalIntrinsic.Real,
  PascalIntrinsic.Real48,
  PascalIntrinsic.Shortint,
  PascalIntrinsic.Shortstring,
  PascalIntrinsic.Single,
  PascalIntrinsic.Smallint,
  PascalKeyword.String,
  PascalIntrinsic.Text,
  PascalIntrinsic.Uint8,
  PascalIntrinsic.Uint16,
  PascalIntrinsic.Uint32,
  PascalIntrinsic.Uint64,
  PascalIntrinsic.Uintptr,
  PascalIntrinsic.Unicodestring,
  PascalIntrinsic.Utf8string,
  PascalIntrinsic.Variant,
  PascalIntrinsic.Widechar,
  PascalIntrinsic.Widestring,
  PascalIntrinsic.Word,
  PascalIntrinsic.Wordbool,
])
const PASCAL_INTRINSIC_IDENTIFIERS = new Set<string>([
  ...PASCAL_INTRINSIC_TYPE_IDENTIFIERS,
  PascalKeyword.False,
  PascalKeyword.Nil,
  PascalKeyword.Result,
  PascalKeyword.Self,
  PascalKeyword.True,
])

const VISIBILITY_KEYWORDS = new Set<string>([
  PascalKeyword.Private,
  PascalKeyword.Protected,
  PascalKeyword.Public,
  PascalKeyword.Published,
  PascalKeyword.Automated,
])
const MEMBER_SECTION_STARTERS = new Set<string>([
  PascalKeyword.Class,
  PascalKeyword.Const,
  PascalKeyword.Constructor,
  PascalKeyword.Destructor,
  PascalKeyword.End,
  PascalKeyword.Function,
  PascalKeyword.Operator,
  PascalKeyword.Private,
  PascalKeyword.Procedure,
  PascalKeyword.Property,
  PascalKeyword.Protected,
  PascalKeyword.Public,
  PascalKeyword.Published,
  PascalKeyword.Strict,
  PascalKeyword.Threadvar,
  PascalKeyword.Type,
  PascalKeyword.Var,
])

/**
 * Check the masked text after a visibility word for a member declaration or attribute,
 * so enum values are not mistaken for section headers.
 */
function nextClassMemberLooksLikeDeclaration(code: string, offset: number) {
  const tail = code.slice(offset)
  const next = /^\s*([A-Za-z_][A-Za-z0-9_]*|.)/.exec(tail)
  if (!next) return true
  if (next[1] === "[") return true // Delphi custom attribute before a member.
  if (!/^[A-Za-z_]/.test(next[1])) return false
  const key = next[1].toLowerCase()
  if (MEMBER_SECTION_STARTERS.has(key)) return true
  const afterName = tail.slice(
    next.index + next[0].lastIndexOf(next[1]) + next[1].length,
  )
  return /^\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*)*:/.test(afterName)
}

/**
 * Returns true only when a contextual visibility word is being used as a
 * class-section directive.  Delphi also legally uses names such as `Public`
 * for enum members, so an unconditional reserved-word blacklist would erase
 * valid symbol coloring.  The masked-code caller supplies comments and strings
 * as whitespace; punctuation after an enum value (`Public,` / `Public)`) keeps
 * those real symbols out of this branch.
 */
function isPascalVisibilityDirectiveAt(
  code: string,
  offset: number,
  identifier: string,
) {
  const key = String(identifier || "").toLowerCase()
  if (key !== PascalKeyword.Strict && !VISIBILITY_KEYWORDS.has(key)) return false
  const lineStart =
    Math.max(code.lastIndexOf("\n", offset - 1), code.lastIndexOf("\r", offset - 1)) + 1
  const prefix = code.slice(lineStart, offset).trim().toLowerCase()
  if (key === PascalKeyword.Strict) {
    if (prefix) return false
    const following = new RegExp(
      String.raw`^\s*(${PascalKeyword.Private}|${PascalKeyword.Protected})\b`,
      "i",
    ).exec(code.slice(offset + identifier.length))
    return Boolean(following)
  }
  if (prefix !== "" && prefix !== PascalKeyword.Strict) return false
  if (
    prefix === PascalKeyword.Strict &&
    key !== PascalKeyword.Private &&
    key !== PascalKeyword.Protected
  )
    return false
  return nextClassMemberLooksLikeDeclaration(code, offset + identifier.length)
}

/**
 * Detect a member access immediately before an identifier while allowing whitespace
 * after the dot.
 */
function isMemberReference(code: string, offset: number) {
  let cursor = offset - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  return code[cursor] === "."
}

/**
 * Recognize ampersand-escaped or dotted identifiers that remain navigable even when
 * their spelling matches a reserved word.
 */
function isEscapedOrQualifiedIdentifier(code: string, offset: number) {
  let cursor = offset - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  return code[cursor] === "." || code[cursor] === "&"
}

/**
 * Test a trimmed identifier against the case-insensitive built-in type and
 * pseudo-variable vocabulary.
 */
function isPascalIntrinsicIdentifier(symbol: unknown) {
  return PASCAL_INTRINSIC_IDENTIFIERS.has(
    String(symbol || "")
      .trim()
      .toLowerCase(),
  )
}

/**
 * Test whether an identifier names a Delphi intrinsic type rather than an ordinary
 * declared symbol.
 */
function isPascalIntrinsicTypeIdentifier(symbol: unknown) {
  return PASCAL_INTRINSIC_TYPE_IDENTIFIERS.has(
    String(symbol || "")
      .trim()
      .toLowerCase(),
  )
}

/**
 * Check whether the qualifier before a dotted identifier is the implicit System unit.
 */
function isSystemQualifiedIdentifier(code: string, offset: number) {
  let cursor = offset - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  if (code[cursor] !== ".") return false
  cursor -= 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_]/.test(code[cursor])) cursor -= 1
  return code.slice(cursor + 1, end).toLowerCase() === "system"
}

/**
 * Classify a call-shaped intrinsic type as a cast, accepting System-qualified casts
 * but excluding escaped names and unrelated member calls.
 */
function isPascalIntrinsicTypeCastAt(
  code: string,
  offset: number,
  identifier: string,
  looksLikeCall = true,
) {
  if (!looksLikeCall || !isPascalIntrinsicTypeIdentifier(identifier)) return false
  let cursor = offset - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  // An escaped identifier is a user symbol even when its spelling matches an intrinsic type.
  if (code[cursor] === "&") return false
  return code[cursor] !== "." || isSystemQualifiedIdentifier(code, offset)
}

/**
 * Suppress navigation only for standalone reserved or intrinsic words and genuine
 * visibility directives; preserve escaped and qualified symbols.
 */
function isPascalNonNavigableIdentifierAt(
  code: string,
  offset: number,
  identifier: string,
) {
  if (isEscapedOrQualifiedIdentifier(code, offset)) return false
  const key = String(identifier || "").toLowerCase()
  if (PASCAL_KEYWORDS.has(key) || isPascalIntrinsicIdentifier(key)) return true
  return (
    (key === PascalKeyword.Strict || VISIBILITY_KEYWORDS.has(key)) &&
    isPascalVisibilityDirectiveAt(code, offset, identifier)
  )
}

/**
 * Infer declaration types, intrinsic casts, routine calls, and member accesses from
 * masked Pascal text when richer symbol metadata is unavailable.
 */
function collectPascalSyntacticColoring(code: string) {
  const typeNames = new Set<string>()
  const typeCasts = new Set<number>()
  const calls = new Set<number>()
  const members = new Map<number, "method" | "property">()

  // This is deliberately restricted to declaration-style colons. It supplies
  // useful coloring when a third-party Unit is available only as a DCU (for
  // example `Params: IJson` or a `TMVCResult` return type).
  for (const declaration of code.matchAll(
    /:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()\r\n]*>)?)/g,
  )) {
    for (const identifier of declaration[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const key = identifier[0].toLowerCase()
      if (!PASCAL_KEYWORDS.has(key)) typeNames.add(key)
    }
  }

  for (const identifier of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const key = identifier[0].toLowerCase()
    const offset = identifier.index
    const suffix = code.slice(offset + identifier[0].length)
    const looksLikeCall = /^\s*(?:<[^<>\r\n]*>\s*)?\(/.test(suffix)
    if (isPascalIntrinsicTypeCastAt(code, offset, identifier[0], looksLikeCall)) {
      typeCasts.add(offset)
      continue
    }
    if (PASCAL_KEYWORDS.has(key)) continue
    if (isMemberReference(code, offset)) {
      members.set(offset, looksLikeCall ? "method" : PascalKeyword.Property)
    } else if (looksLikeCall && !typeNames.has(key)) {
      calls.add(offset)
    }
  }

  return { typeNames, typeCasts, calls, members }
}

export {
  collectPascalSyntacticColoring,
  isPascalIntrinsicIdentifier,
  isPascalIntrinsicTypeCastAt,
  isPascalIntrinsicTypeIdentifier,
  isPascalNonNavigableIdentifierAt,
  isPascalVisibilityDirectiveAt,
}
