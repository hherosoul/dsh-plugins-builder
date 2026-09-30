// Internal lexical analysis helpers shared by validate_plugin.js and
// verify_plugin.js (same family as _cli.js: no CLI form, not a tool).
//
// Honest scope: this is a LEXER, not a parser — no AST, no semantic analysis.
// It upgrades the whole-text regex heuristics to string/comment-safe token
// matching with balanced-block scoping, but rules stay [W] heuristics and
// semantic re-check still belongs to Phase 4 (qa-playbook 已知盲区).
//
// Known approximations (documented, never pretend certainty):
//   - Template literals become ONE string token; `${...}` interpolations are
//     kept as raw text inside the value (tokens inside interpolations are lost).
//   - Regex literals are distinguished from division by the "previous
//     significant token" heuristic (ident/number/`)`/`]` or a regex-preceding
//     keyword => division, otherwise scanned as a regex literal).
//   - Non-ASCII identifiers fall through as punct (conservative skip).
//
// Never throws: unterminated strings/templates/regexes run to EOF and callers
// degrade conservatively (worst case a rule skips).

const OPEN = '([{'
const CLOSE = ')]}'
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
])

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch)
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch)
}

/** Tokenize JS/TS source into {type, value, start, line} tokens. */
export function tokenize(source) {
  const tokens = []
  const n = source.length
  let i = 0
  let line = 1
  let prev = null // last significant token (regex-vs-division heuristic)
  const push = (type, value, start) => {
    const tok = { type, value, start, line }
    tokens.push(tok)
    prev = tok
    return tok
  }
  while (i < n) {
    const ch = source[i]
    if (ch === '\n') {
      line += 1
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1
      continue
    }
    // Line comment.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    // Block comment.
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1
        i += 1
      }
      i += 2
      continue
    }
    // Quoted strings (single/double): value = raw content, escapes kept.
    if (ch === '"' || ch === "'") {
      const start = i
      i += 1
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') i += 1
        if (source[i] === '\n') line += 1
        i += 1
      }
      const value = source.slice(start + 1, Math.min(i, n))
      i += 1
      push('string', value, start)
      continue
    }
    // Template literal: one string token, interpolations kept as raw text.
    if (ch === '`') {
      const start = i
      i += 1
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') i += 1
        if (source[i] === '\n') line += 1
        i += 1
      }
      const value = source.slice(start + 1, Math.min(i, n))
      i += 1
      push('string', value, start)
      continue
    }
    // '/' — regex literal vs division (heuristic, see header).
    if (ch === '/') {
      const divisionAfter = prev && (
        prev.type === 'ident' || prev.type === 'number' || prev.type === 'string' || prev.type === 'regex'
        || (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'))
      )
      const keywordBefore = prev && prev.type === 'ident' && REGEX_PRECEDING_KEYWORDS.has(prev.value)
      if (divisionAfter && !keywordBefore) {
        push('punct', '/', i)
        i += 1
        continue
      }
      // Try scanning a regex literal to an unescaped '/' outside [...] classes.
      let j = i + 1
      let inClass = false
      let terminated = false
      while (j < n) {
        const c = source[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '\n') break // not a valid regex -> treat as division below
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          terminated = true
          break
        }
        j += 1
      }
      if (terminated) {
        j += 1
        while (j < n && /[dgimsuvy]/i.test(source[j])) j += 1 // flags
        push('regex', source.slice(i, j), i)
        i = j
        continue
      }
      push('punct', '/', i)
      i += 1
      continue
    }
    // Numbers (decimal / hex / binary / octal / BigInt / separators / exponent).
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const start = i
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*\.?[\d_]*([eE][+-]?\d+)?|\.\d[\d_]*([eE][+-]?\d+)?))n?/.exec(source.slice(i))
      const value = m ? m[0] : ch
      i += value.length
      push('number', value, start)
      continue
    }
    // Identifiers / keywords (ASCII only; non-ASCII falls to punct).
    if (isIdentStart(ch)) {
      const start = i
      i += 1
      while (i < n && isIdentPart(source[i])) i += 1
      push('ident', source.slice(start, i), start)
      continue
    }
    // Everything else: single-char punctuation.
    push('punct', ch, i)
    i += 1
  }
  return tokens
}

/** Exclusive end index of the balanced region opening at tokens[openIdx]. */
export function balancedEnd(tokens, openIdx) {
  const open = tokens[openIdx]
  if (!open || open.type !== 'punct') return openIdx + 1
  const kind = OPEN.indexOf(open.value)
  if (kind < 0) return openIdx + 1
  const want = CLOSE.charAt(kind)
  let depth = 0
  for (let j = openIdx; j < tokens.length; j += 1) {
    const t = tokens[j]
    if (t.type !== 'punct') continue
    if (t.value === open.value) depth += 1
    if (t.value === want) {
      depth -= 1
      if (depth === 0) return j + 1
    }
  }
  return tokens.length
}

/** True when tokens contain the consecutive ident sequence `idents`. */
export function hasSequence(tokens, idents) {
  const len = idents.length
  for (let i = 0; i + len <= tokens.length; i += 1) {
    let ok = true
    for (let k = 0; k < len; k += 1) {
      const t = tokens[i + k]
      if (!t || t.type !== 'ident' || t.value !== idents[k]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Values of all string tokens (quoted + template literals). */
export function stringValues(tokens) {
  const out = []
  for (const t of tokens) {
    if (t.type === 'string') out.push(t.value)
  }
  return out
}

/** Property names accessed as `objectName.<prop>` (ident member accesses only). */
export function memberAccesses(tokens, objectName) {
  const out = new Set()
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const t = tokens[i]
    const dot = tokens[i + 1]
    const prop = tokens[i + 2]
    if (t.type === 'ident' && t.value === objectName
      && dot.type === 'punct' && dot.value === '.'
      && prop.type === 'ident') out.add(prop.value)
  }
  return out
}

/**
 * Balanced argument blocks of a call like marker(...) or Schema.object(...).
 * `idents` is a dotted chain, e.g. ['defineTool'] or ['Schema', 'object'].
 * Returns [{ tokens: innerTokens, startIdx, endIdx }] (endIdx exclusive,
 * pointing after the closing paren; unterminated blocks run to EOF).
 */
export function callBlocks(tokens, idents) {
  const blocks = []
  const chain = idents.length
  for (let i = 0; i + 2 * chain <= tokens.length; i += 1) {
    let ok = true
    for (let k = 0; k < chain; k += 1) {
      const t = tokens[i + 2 * k]
      if (!t || t.type !== 'ident' || t.value !== idents[k]) {
        ok = false
        break
      }
      if (k + 1 < chain) {
        const dot = tokens[i + 2 * k + 1]
        if (!dot || dot.type !== 'punct' || dot.value !== '.') {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    const parenIdx = i + 2 * chain - 1
    const paren = tokens[parenIdx]
    if (!paren || paren.type !== 'punct' || paren.value !== '(') continue
    const end = balancedEnd(tokens, parenIdx)
    blocks.push({ tokens: tokens.slice(parenIdx + 1, end - 1), startIdx: i, endIdx: end })
    i = end - 1
  }
  return blocks
}

/** Single-ident convenience wrapper around callBlocks. */
export function extractBlocks(tokens, marker) {
  return callBlocks(tokens, [marker])
}

/**
 * Token region of a property's VALUE inside a block, e.g. the `execute`
 * function or the `parameters` object of a defineTool block. Accepts both
 * `name: value` (until a depth-0 ',' or the enclosing block end) and the
 * method shorthand `name(args) { body }`. Returns null when not found.
 */
export function propValueBlock(blockTokens, propName) {
  for (let i = 0; i + 1 < blockTokens.length; i += 1) {
    const t = blockTokens[i]
    if (t.type !== 'ident' || t.value !== propName) continue
    const next = blockTokens[i + 1]
    // `name: value`
    if (next.type === 'punct' && next.value === ':') {
      const start = i + 2
      let depth = 0
      let j = start
      while (j < blockTokens.length) {
        const v = blockTokens[j]
        if (v.type === 'punct') {
          if (OPEN.includes(v.value)) depth += 1
          else if (CLOSE.includes(v.value)) {
            if (depth === 0) break // enclosing block closed
            depth -= 1
          } else if (v.value === ',' && depth === 0) break // next property
        }
        j += 1
      }
      return blockTokens.slice(start, j)
    }
    // method shorthand `name(args) { body }`
    if (next.type === 'punct' && next.value === '(') {
      const argsEnd = balancedEnd(blockTokens, i + 1)
      let end = argsEnd
      const brace = blockTokens[argsEnd]
      if (brace && brace.type === 'punct' && brace.value === '{') end = balancedEnd(blockTokens, argsEnd)
      return blockTokens.slice(i + 1, end)
    }
  }
  return null
}
