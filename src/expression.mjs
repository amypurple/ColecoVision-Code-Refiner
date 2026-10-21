const OPERATORS = {
  "||": { precedence: 1, apply: (a, b) => Number(Boolean(a) || Boolean(b)) },
  "&&": { precedence: 2, apply: (a, b) => Number(Boolean(a) && Boolean(b)) },
  "|": { precedence: 3, apply: (a, b) => a | b },
  "^": { precedence: 4, apply: (a, b) => a ^ b },
  "&": { precedence: 5, apply: (a, b) => a & b },
  "==": { precedence: 6, apply: (a, b) => Number(a === b) },
  "!=": { precedence: 6, apply: (a, b) => Number(a !== b) },
  "<": { precedence: 7, apply: (a, b) => Number(a < b) },
  "<=": { precedence: 7, apply: (a, b) => Number(a <= b) },
  ">": { precedence: 7, apply: (a, b) => Number(a > b) },
  ">=": { precedence: 7, apply: (a, b) => Number(a >= b) },
  "<<": { precedence: 8, apply: (a, b) => a << b },
  ">>": { precedence: 8, apply: (a, b) => a >> b },
  "+": { precedence: 9, apply: (a, b) => a + b },
  "-": { precedence: 9, apply: (a, b) => a - b },
  "*": { precedence: 10, apply: (a, b) => a * b },
  "/": { precedence: 10, apply: (a, b) => Math.trunc(a / b) },
  "%": { precedence: 10, apply: (a, b) => a % b }
};

function tokenize(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    const match = rest.match(/^(?:\$[0-9a-f]+|0x[0-9a-f]+|%[01]+|\d+|[a-z_.$?][\w.$?]*|<<|>>|<=|>=|==|!=|&&|\|\||[()+\-*/%&|^~!<>])/i);
    if (!match) throw new Error(`unsupported token near '${rest.slice(0, 16)}'`);
    tokens.push(match[0]);
    offset += match[0].length;
  }
  return tokens;
}

function numberValue(token) {
  if (/^\$/.test(token)) return Number.parseInt(token.slice(1), 16);
  if (/^0x/i.test(token)) return Number.parseInt(token.slice(2), 16);
  if (/^%/.test(token)) return Number.parseInt(token.slice(1), 2);
  return Number.parseInt(token, 10);
}

export function evaluateExpression(source, symbols = new Map()) {
  const tokens = tokenize(String(source).trim());
  let index = 0;

  function parsePrimary() {
    const token = tokens[index++];
    if (token === undefined) throw new Error("missing expression operand");
    if (token === "(") {
      const value = parseBinary(0);
      if (tokens[index++] !== ")") throw new Error("missing closing parenthesis");
      return value;
    }
    if (["+", "-", "~", "!"].includes(token)) {
      const value = parsePrimary();
      if (token === "+") return value;
      if (token === "-") return -value;
      if (token === "~") return ~value;
      return Number(!value);
    }
    if (/^(?:\$|0x|%|\d)/i.test(token)) return numberValue(token);
    const key = token.toUpperCase();
    if (!symbols.has(key)) throw new Error(`unknown symbol '${token}'`);
    return symbols.get(key);
  }

  function parseBinary(minimumPrecedence) {
    let left = parsePrimary();
    while (index < tokens.length) {
      const operator = OPERATORS[tokens[index]];
      if (!operator || operator.precedence < minimumPrecedence) break;
      index += 1;
      const right = parseBinary(operator.precedence + 1);
      left = operator.apply(left, right);
    }
    return left;
  }

  const value = parseBinary(0);
  if (index !== tokens.length) throw new Error(`unexpected token '${tokens[index]}'`);
  if (!Number.isFinite(value)) throw new Error("expression is not finite");
  return value;
}
