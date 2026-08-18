/* A small Python — enough to read the cells on this bench, and to colour them.
 *
 * WHY THIS EXISTS. The bench's claim is that both arrangements reach the same
 * answer, and it is only worth making if it is measured. In JavaScript that was
 * free: `new Function` on the assembled source and call it. Python in a browser
 * is not free, and the three ways out were all worse than this one. Shipping a
 * whole CPython to WebAssembly is ten megabytes and a third-party fetch, which
 * would take the tool off `local` for a page of arithmetic. Showing Python and
 * running JavaScript underneath is the kind of quiet lie this site exists not to
 * tell. Showing Python and running nothing turns a measurement back into a
 * claim.
 *
 * So the cells are Python and this reads them. Expressions only, which is all a
 * cell is ever allowed to be:
 *
 *   names, attributes, calls          r, math.pi, math.hypot(b, h)
 *   numbers, strings, f-strings       2, 1.5, "x", f"circle r={r}"
 *   True False None
 *   ** unary- * / // % + -            with Python's precedence and its int rules
 *   < <= > >= == !=  not and or
 *
 * No statements, no lambdas, no comprehensions, no slicing. A cell that reaches
 * past that gets a parse error where the answer would be, which is the honest
 * report: the bench says what it can read and does not pretend past it.
 *
 * ONE LEXER, TWO JOBS. The same token stream that feeds the parser feeds the
 * syntax colouring, so a thing coloured as a number is a thing the evaluator
 * read as a number. A separate regex highlighter would be a second opinion
 * about the language, and two opinions drift.
 *
 * INTS ARE NOT FLOATS, and the bench would be lying about Python if it said
 * otherwise. `b * h / 2` on 4 and 3 is 6.0 in Python and 6 in JavaScript, so
 * every value carries its type: `/` always widens, `//` and `%` and `**` and
 * the three arithmetic operators keep int when both sides are int, and `math`
 * returns float. That is why values are wrapped rather than being bare numbers.
 */
(function (root) {
  "use strict";

  /* ── values ─────────────────────────────────────────────────────────────
     { t: "int" | "float" | "str" | "bool" | "none" | "obj" | "fn", v }  */
  const int = (v) => ({ t: "int", v: v });
  const flo = (v) => ({ t: "float", v: v });
  const str = (v) => ({ t: "str", v: v });
  const bool = (v) => ({ t: "bool", v: v });
  const NONE = { t: "none", v: null };

  const isNum = (x) => x.t === "int" || x.t === "float";
  const num = (a, b, v) => (a.t === "int" && b.t === "int" ? int(v) : flo(v));

  function truthy(x) {
    if (x.t === "none") return false;
    if (x.t === "bool") return x.v;
    if (isNum(x)) return x.v !== 0;
    if (x.t === "str") return x.v.length > 0;
    return true;
  }

  /* How Python PRINTS a value, which is not how JavaScript prints it. A float
     that happens to be whole still says so — 6.0, not 6 — because that is the
     one difference a reader would spot and call the bench wrong for.

     `print()` rather than `show()`, deliberately: a string comes back bare
     rather than quoted, which is what a table of answers wants and what an
     f-string does with `{r}`. For every other type the two agree. */
  function show(x) {
    if (!x || !x.t) return String(x);
    switch (x.t) {
      case "none": return "None";
      case "bool": return x.v ? "True" : "False";
      case "int": return String(x.v);
      case "float":
        if (!isFinite(x.v)) return x.v > 0 ? "inf" : (x.v < 0 ? "-inf" : "nan");
        return Number.isInteger(x.v) ? `${x.v}.0` : String(x.v);
      case "str": return x.v;
      default: return `<${x.t}>`;
    }
  }

  // Two values are the same value. Used to compare what the two arrangements
  // came back with, so it has to see the int/float difference the same way
  // `repr` does — 6 and 6.0 print differently and are different results here.
  function same(a, b) {
    if (!a || !b || a.t !== b.t) return false;
    if (isNum(a)) return Object.is(a.v, b.v);
    return a.v === b.v;
  }

  /* ── the standard library, as far as a cell needs it ─────────────────── */
  const fn = (name, arity, body) => ({ t: "fn", name: name, arity: arity, v: body });
  const mathFn = (name, f) => fn(`math.${name}`, f.length, (args) => flo(f(...args.map((a) => a.v))));

  const MATH = {
    t: "obj",
    name: "math",
    v: {
      pi: flo(Math.PI),
      e: flo(Math.E),
      tau: flo(Math.PI * 2),
      sqrt: mathFn("sqrt", Math.sqrt),
      hypot: mathFn("hypot", Math.hypot),
      sin: mathFn("sin", Math.sin),
      cos: mathFn("cos", Math.cos),
      tan: mathFn("tan", Math.tan),
      atan: mathFn("atan", Math.atan),
      log: mathFn("log", Math.log),
      exp: mathFn("exp", Math.exp),
      floor: fn("math.floor", 1, (a) => int(Math.floor(a[0].v))),
      ceil: fn("math.ceil", 1, (a) => int(Math.ceil(a[0].v))),
    },
  };

  const BUILTINS = {
    math: MATH,
    True: bool(true),
    False: bool(false),
    None: NONE,
    abs: fn("abs", 1, (a) => (a[0].t === "int" ? int(Math.abs(a[0].v)) : flo(Math.abs(a[0].v)))),
    round: fn("round", 1, (a) => int(Math.round(a[0].v))),
    min: fn("min", 2, (a) => a.reduce((x, y) => (y.v < x.v ? y : x))),
    max: fn("max", 2, (a) => a.reduce((x, y) => (y.v > x.v ? y : x))),
    int: fn("int", 1, (a) => int(Math.trunc(a[0].t === "str" ? parseFloat(a[0].v) : a[0].v))),
    float: fn("float", 1, (a) => flo(a[0].t === "str" ? parseFloat(a[0].v) : a[0].v)),
    str: fn("str", 1, (a) => str(show(a[0]))),
    len: fn("len", 1, (a) => int(String(a[0].v).length)),
  };

  /* ── the lexer ──────────────────────────────────────────────────────────
     Covers the whole source with tokens, whitespace and comments included, so
     the colouring can be rebuilt from the stream without consulting the
     original text again. The parser drops what it does not want. */
  const KEYWORDS = new Set([
    "and", "as", "assert", "break", "case", "class", "continue", "def", "del",
    "elif", "else", "except", "finally", "for", "from", "global", "if", "import",
    "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield",
  ]);
  // Not keywords, and coloured as if they were, the way an editor does. `self`
  // is a convention Python does not enforce and every reader reads as one.
  const SOFT = new Set(["self", "True", "False", "None"]);

  const OPS = [
    "**=", "//=", "...", "**", "//", "<<", ">>", "<=", ">=", "==", "!=", "->",
    "+=", "-=", "*=", "/=", ":=", "+", "-", "*", "/", "%", "<", ">", "=", "~",
    "^", "&", "|",
  ];
  const PUNC = new Set(["(", ")", "[", "]", "{", "}", ",", ":", ".", ";", "@"]);

  function tokenize(source) {
    const out = [];
    let i = 0;
    const push = (type, text) => out.push({ type: type, text: text });

    while (i < source.length) {
      const c = source[i];

      if (c === "\n") { push("nl", c); i++; continue; }
      if (c === " " || c === "\t" || c === "\r") {
        let j = i;
        while (j < source.length && (source[j] === " " || source[j] === "\t" || source[j] === "\r")) j++;
        push("ws", source.slice(i, j));
        i = j;
        continue;
      }
      if (c === "#") {
        let j = i;
        while (j < source.length && source[j] !== "\n") j++;
        push("comment", source.slice(i, j));
        i = j;
        continue;
      }

      // A string, possibly with an f in front of it. The f-string's braces are
      // read here rather than later, so the colouring can put code colours back
      // inside a string and the parser can find the expressions without
      // rescanning the literal.
      const prefix = /^[fF]?["']/.exec(source.slice(i));
      if (prefix) {
        const isF = prefix[0].length === 2;
        const quote = prefix[0][prefix[0].length - 1];
        let j = i + prefix[0].length;
        let depth = 0;
        while (j < source.length) {
          if (source[j] === "\\") { j += 2; continue; }
          if (isF && source[j] === "{") depth++;
          if (isF && source[j] === "}") depth = Math.max(0, depth - 1);
          if (source[j] === quote && depth === 0) { j++; break; }
          j++;
        }
        push(isF ? "fstring" : "string", source.slice(i, j));
        i = j;
        continue;
      }

      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] || ""))) {
        let j = i;
        while (j < source.length && /[0-9_.eE]/.test(source[j])) {
          if ((source[j] === "e" || source[j] === "E") && /[+-]/.test(source[j + 1] || "")) j++;
          j++;
        }
        push("number", source.slice(i, j));
        i = j;
        continue;
      }

      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
        const word = source.slice(i, j);
        push(KEYWORDS.has(word) ? "keyword" : (SOFT.has(word) ? "soft" : "name"), word);
        i = j;
        continue;
      }

      const op = OPS.find((candidate) => source.startsWith(candidate, i));
      if (op) { push("op", op); i += op.length; continue; }
      if (PUNC.has(c)) { push("punc", c); i++; continue; }

      push("bad", c);
      i++;
    }
    return out;
  }

  /* ── colouring ──────────────────────────────────────────────────────────
     One span per token, and the only thing decided here that the lexer did not
     already decide is the name straight after `def` or `class`, which is the
     thing being declared rather than a thing being used. An f-string is taken
     apart again so the expressions inside it are coloured as code — a reader
     who cannot see `{r}` is code inside `f"circle r={r}"` has been told the
     wrong thing about f-strings. */
  const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  const escape = (text) => String(text).replace(/[&<>]/g, (ch) => ESCAPE[ch]);
  const span = (cls, text) => (cls ? `<span class="tk-${cls}">${escape(text)}</span>` : escape(text));

  function paintFString(text) {
    const out = [];
    let i = 0;
    let plain = "";
    while (i < text.length) {
      if (text[i] === "{" && text[i + 1] === "{") { plain += "{{"; i += 2; continue; }
      if (text[i] !== "{") { plain += text[i]; i++; continue; }
      let j = i + 1;
      let depth = 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        if (text[j] === "}") depth--;
        j++;
      }
      if (plain) { out.push(span("string", plain)); plain = ""; }
      out.push(span("string", "{"));
      out.push(paint(text.slice(i + 1, j - 1)));
      out.push(span("string", "}"));
      i = j;
    }
    if (plain) out.push(span("string", plain));
    return out.join("");
  }

  function paint(source) {
    const tokens = tokenize(source);
    let declaring = false;
    return tokens.map((token) => {
      if (token.type === "fstring") return paintFString(token.text);
      if (token.type === "keyword" && (token.text === "def" || token.text === "class")) {
        declaring = true;
        return span("keyword", token.text);
      }
      if (token.type === "name" && declaring) {
        declaring = false;
        return span("declared", token.text);
      }
      if (token.type === "ws" || token.type === "nl") return escape(token.text);
      // A plain name is the page's own ink. Marking a called name would want a
      // sixth colour to say anything with, and the palette has three plate
      // companions and three steps of ink in it — no more.
      if (token.type === "name") return escape(token.text);
      return span(token.type, token.text);
    }).join("");
  }

  /* ── the parser ─────────────────────────────────────────────────────────
     Pratt, over the expression grammar at the top of this file. Binding powers
     are Python's own table read downward, so anything this accepts means here
     what it means there. */
  const BINDING = {
    "or": 1, "and": 2,
    "==": 4, "!=": 4, "<": 4, "<=": 4, ">": 4, ">=": 4,
    "+": 6, "-": 6,
    "*": 7, "/": 7, "//": 7, "%": 7,
    "**": 9,
  };

  function parse(source) {
    const tokens = tokenize(source).filter((t) => t.type !== "ws" && t.type !== "nl" && t.type !== "comment");
    let at = 0;
    const peek = () => tokens[at];
    const next = () => tokens[at++];
    const fail = (message) => { throw new SyntaxError(message); };
    const eat = (text) => {
      if (!peek() || peek().text !== text) fail(`expected ${text}`);
      return next();
    };

    function expression(power) {
      let left = unary();
      for (;;) {
        const token = peek();
        if (!token) break;
        if (token.text === "not" && tokens[at + 1] && tokens[at + 1].text === "in") break;
        const bp = BINDING[token.text];
        if (bp === undefined || bp <= power) break;
        next();
        // ** binds to the right: 2 ** 3 ** 2 is 2 ** (3 ** 2).
        const right = expression(token.text === "**" ? bp - 1 : bp);
        left = { node: "binary", op: token.text, left: left, right: right };
      }
      return left;
    }

    function unary() {
      const token = peek();
      if (token && (token.text === "-" || token.text === "+")) {
        next();
        // Below ** and above everything else, which is the one bit of Python's
        // precedence that surprises people: -2 ** 2 is -4, because the power is
        // taken first and the sign applied to the result.
        return { node: "unary", op: token.text, arg: expression(8) };
      }
      if (token && token.text === "not") {
        next();
        return { node: "unary", op: "not", arg: expression(3) };
      }
      return postfix(primary());
    }

    function postfix(base) {
      for (;;) {
        const token = peek();
        if (!token) return base;
        if (token.text === ".") {
          next();
          const name = next();
          if (!name || (name.type !== "name" && name.type !== "soft")) fail("expected a name after .");
          base = { node: "attr", of: base, name: name.text };
          continue;
        }
        if (token.text === "(") {
          next();
          const args = [];
          if (peek() && peek().text !== ")") {
            args.push(expression(0));
            while (peek() && peek().text === ",") { next(); args.push(expression(0)); }
          }
          eat(")");
          base = { node: "call", callee: base, args: args };
          continue;
        }
        return base;
      }
    }

    function primary() {
      const token = next();
      if (!token) fail("the expression stops early");
      if (token.type === "number") {
        const text = token.text.replace(/_/g, "");
        return { node: "const", value: /[.eE]/.test(text) ? flo(parseFloat(text)) : int(parseInt(text, 10)) };
      }
      if (token.type === "string") return { node: "const", value: str(unquote(token.text)) };
      if (token.type === "fstring") return { node: "fstring", parts: splitFString(token.text) };
      if (token.type === "soft" || token.type === "name") return { node: "name", name: token.text };
      if (token.text === "(") {
        const inner = expression(0);
        eat(")");
        return inner;
      }
      fail(`cannot read ${token.text}`);
    }

    const tree = expression(0);
    if (at < tokens.length) fail(`unexpected ${tokens[at].text}`);
    return tree;
  }

  function unquote(literal) {
    const quote = literal[0];
    const body = literal.slice(1, literal.endsWith(quote) && literal.length > 1 ? -1 : undefined);
    return body.replace(/\\(.)/g, (_, ch) => ({ n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" }[ch] || ch));
  }

  // An f-string as an alternating list: literal text, then a parsed expression,
  // then literal text. Format specs after a colon are not supported and say so.
  function splitFString(literal) {
    const quote = literal[literal[0] === "f" || literal[0] === "F" ? 1 : 0];
    const start = literal.indexOf(quote) + 1;
    const body = literal.slice(start, literal.endsWith(quote) ? -1 : undefined);
    const parts = [];
    let plain = "";
    let i = 0;
    while (i < body.length) {
      if (body[i] === "{" && body[i + 1] === "{") { plain += "{"; i += 2; continue; }
      if (body[i] === "}" && body[i + 1] === "}") { plain += "}"; i += 2; continue; }
      if (body[i] !== "{") { plain += body[i]; i++; continue; }
      let j = i + 1;
      let depth = 1;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth++;
        if (body[j] === "}") depth--;
        j++;
      }
      parts.push({ text: plain.replace(/\\(.)/g, (_, ch) => (ch === "n" ? "\n" : ch)) });
      plain = "";
      parts.push({ tree: parse(body.slice(i + 1, j - 1)) });
      i = j;
    }
    if (plain) parts.push({ text: plain.replace(/\\(.)/g, (_, ch) => (ch === "n" ? "\n" : ch)) });
    return parts;
  }

  /* ── the evaluator ──────────────────────────────────────────────────── */
  function evalTree(node, env) {
    switch (node.node) {
      case "const":
        return node.value;

      case "name": {
        if (Object.prototype.hasOwnProperty.call(env, node.name)) return env[node.name];
        if (Object.prototype.hasOwnProperty.call(BUILTINS, node.name)) return BUILTINS[node.name];
        throw new ReferenceError(`name '${node.name}' is not defined`);
      }

      case "attr": {
        const base = evalTree(node.of, env);
        if (base.t !== "obj" || !Object.prototype.hasOwnProperty.call(base.v, node.name)) {
          throw new TypeError(`'${base.name || base.t}' has no attribute '${node.name}'`);
        }
        return base.v[node.name];
      }

      case "call": {
        const callee = evalTree(node.callee, env);
        if (callee.t !== "fn") throw new TypeError("object is not callable");
        const args = node.args.map((arg) => evalTree(arg, env));
        return callee.v(args);
      }

      case "fstring":
        return str(node.parts.map((part) =>
          "text" in part ? part.text : show(evalTree(part.tree, env))).join(""));

      case "unary": {
        const arg = evalTree(node.arg, env);
        if (node.op === "not") return bool(!truthy(arg));
        if (!isNum(arg)) throw new TypeError(`bad operand for unary ${node.op}`);
        return arg.t === "int" ? int(node.op === "-" ? -arg.v : arg.v) : flo(node.op === "-" ? -arg.v : arg.v);
      }

      case "binary": {
        if (node.op === "and") {
          const left = evalTree(node.left, env);
          return truthy(left) ? evalTree(node.right, env) : left;
        }
        if (node.op === "or") {
          const left = evalTree(node.left, env);
          return truthy(left) ? left : evalTree(node.right, env);
        }
        return binary(node.op, evalTree(node.left, env), evalTree(node.right, env));
      }

      default:
        throw new SyntaxError("cannot evaluate this");
    }
  }

  function binary(op, a, b) {
    if (op === "==") return bool(same(a, b) || (isNum(a) && isNum(b) && a.v === b.v));
    if (op === "!=") return bool(!(same(a, b) || (isNum(a) && isNum(b) && a.v === b.v)));

    if (a.t === "str" && b.t === "str") {
      if (op === "+") return str(a.v + b.v);
      if (op === "<") return bool(a.v < b.v);
      if (op === ">") return bool(a.v > b.v);
      throw new TypeError(`bad operand types for ${op}`);
    }
    if (a.t === "str" && op === "*" && b.t === "int") return str(a.v.repeat(Math.max(0, b.v)));
    if (!isNum(a) || !isNum(b)) throw new TypeError(`bad operand types for ${op}`);

    switch (op) {
      case "+": return num(a, b, a.v + b.v);
      case "-": return num(a, b, a.v - b.v);
      case "*": return num(a, b, a.v * b.v);
      // True division always widens, which is the whole reason values carry a
      // type here rather than being bare numbers.
      case "/":
        if (b.v === 0) throw new RangeError("division by zero");
        return flo(a.v / b.v);
      case "//":
        if (b.v === 0) throw new RangeError("integer division or modulo by zero");
        return num(a, b, Math.floor(a.v / b.v));
      case "%":
        if (b.v === 0) throw new RangeError("integer division or modulo by zero");
        // Python's remainder takes the sign of the divisor; JavaScript's takes
        // the sign of the dividend, and -7 % 3 is 2 in one and -1 in the other.
        return num(a, b, a.v - Math.floor(a.v / b.v) * b.v);
      case "**": return num(a, b, Math.pow(a.v, b.v));
      case "<": return bool(a.v < b.v);
      case "<=": return bool(a.v <= b.v);
      case ">": return bool(a.v > b.v);
      case ">=": return bool(a.v >= b.v);
      default: throw new SyntaxError(`unknown operator ${op}`);
    }
  }

  // The whole public surface: read an expression with these names bound.
  function evaluate(source, bindings) {
    return evalTree(parse(source), bindings || {});
  }

  root.Py = {
    tokenize: tokenize,
    paint: paint,
    parse: parse,
    evaluate: evaluate,
    show: show,
    same: same,
    int: int,
    float: flo,
    str: str,
    bool: bool,
    none: NONE,
  };
})(typeof self !== 'undefined' ? self : globalThis);
