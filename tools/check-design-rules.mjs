import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repositoryRoot, 'tools/design-rules-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const failures = [];
const styleCounts = new Map();
const animationCounts = new Map();
const transitionCounts = new Map();
const keyframeCounts = new Map();
const cssFiles = listFiles(path.join(repositoryRoot, 'src'), '.css');
const tsxFiles = listFiles(path.join(repositoryRoot, 'src'), '.tsx');

const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext`.split(
    /\s+/,
  ),
);

const cssWideKeywords = new Set(['inherit', 'initial', 'revert', 'revert-layer', 'unset']);
const semanticColorKeywords = new Set(['currentcolor']);
const structuralTransparentProperties = new Set([
  'background',
  'background-color',
  'border',
  'border-block',
  'border-block-end',
  'border-block-start',
  'border-bottom',
  'border-color',
  'border-inline',
  'border-inline-end',
  'border-inline-start',
  'border-left',
  'border-right',
  'border-top',
  'fill',
  'outline',
  'outline-color',
  'scrollbar-color',
  'stroke',
]);
const directColorProperties = new Set([
  'accent-color',
  'background-color',
  'border-block-color',
  'border-block-end-color',
  'border-block-start-color',
  'border-bottom-color',
  'border-color',
  'border-inline-color',
  'border-inline-end-color',
  'border-inline-start-color',
  'border-left-color',
  'border-right-color',
  'border-top-color',
  'caret-color',
  'color',
  'column-rule-color',
  'fill',
  'flood-color',
  'lighting-color',
  'outline-color',
  'scrollbar-color',
  'stop-color',
  'stroke',
  'text-decoration-color',
  'text-emphasis-color',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
]);
const colorShorthandProperties = new Set([
  'background',
  'border',
  'border-block',
  'border-block-end',
  'border-block-start',
  'border-bottom',
  'border-inline',
  'border-inline-end',
  'border-inline-start',
  'border-left',
  'border-right',
  'border-top',
  'box-shadow',
  'column-rule',
  'outline',
  'text-decoration',
  'text-emphasis',
  'text-shadow',
]);
const literalColorFunctions = new Set([
  'color',
  'device-cmyk',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'rgb',
  'rgba',
]);
const colorContainerFunctions = new Set([
  ...literalColorFunctions,
  'color-contrast',
  'color-mix',
  'light-dark',
]);
const cssResetValues = new Set(['initial', 'none', 'revert', 'revert-layer', 'unset']);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function toRepositoryPath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath, extension);
      return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
    })
    .sort();
}

function report(file, line, message) {
  failures.push(`${file}:${line}: ${message}`);
}

function baselineKey(file, element, expression) {
  return JSON.stringify([file, element, expression]);
}

function baselineCounter(entries, keyForEntry) {
  const result = new Map();
  for (const entry of entries ?? []) {
    const key = keyForEntry(entry);
    result.set(key, (result.get(key) ?? 0) + entry.count);
  }
  return result;
}

function isNameCharacter(character) {
  return (
    character !== undefined &&
    (/[a-zA-Z0-9_-]/.test(character) || character.charCodeAt(0) >= 0x80 || character === '\\')
  );
}

function consumeCssEscape(input, start) {
  let index = start + 1;
  if (index >= input.length) return { value: '\uFFFD', end: index };

  if (/[\da-f]/i.test(input[index])) {
    let hex = '';
    while (index < input.length && hex.length < 6 && /[\da-f]/i.test(input[index])) {
      hex += input[index];
      index += 1;
    }
    if (/\s/.test(input[index] ?? '')) index += 1;
    const codePoint = Number.parseInt(hex, 16);
    return {
      value: codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint),
      end: index,
    };
  }

  return { value: input[index], end: index + 1 };
}

function consumeCssName(input, start) {
  let index = start;
  let value = '';
  while (isNameCharacter(input[index])) {
    if (input[index] === '\\') {
      const escape = consumeCssEscape(input, index);
      value += escape.value;
      index = escape.end;
    } else {
      value += input[index];
      index += 1;
    }
  }
  return { value, end: index };
}

function parseCssValue(value) {
  let index = 0;

  function parseNodes(stopAtClosingParen = false) {
    const nodes = [];
    while (index < value.length) {
      const character = value[index];
      if (character === ')' && stopAtClosingParen) {
        index += 1;
        return nodes;
      }
      if (character === '/' && value[index + 1] === '*') {
        const commentEnd = value.indexOf('*/', index + 2);
        index = commentEnd === -1 ? value.length : commentEnd + 2;
        continue;
      }
      if (character === '"' || character === "'") {
        const quote = character;
        index += 1;
        while (index < value.length && value[index] !== quote) {
          if (value[index] === '\\') index += 1;
          index += 1;
        }
        index += 1;
        continue;
      }
      if (character === '#') {
        const name = consumeCssName(value, index + 1);
        if (name.end > index + 1) {
          nodes.push({ type: 'hash', value: name.value.toLowerCase() });
          index = name.end;
          continue;
        }
      }
      if (isNameCharacter(character) && !/[\d]/.test(character)) {
        const name = consumeCssName(value, index);
        index = name.end;
        if (value[index] === '(') {
          index += 1;
          nodes.push({
            type: 'function',
            value: name.value.toLowerCase(),
            children: parseNodes(true),
          });
        } else {
          nodes.push({ type: 'word', value: name.value.toLowerCase() });
        }
        continue;
      }
      index += 1;
    }
    return nodes;
  }

  return parseNodes();
}

function isColorProperty(property) {
  if (directColorProperties.has(property) || colorShorthandProperties.has(property)) return true;
  if (property.startsWith('--')) {
    return /(?:color|background|border|fill|stroke|shadow|foreground)/i.test(property);
  }
  return false;
}

function normalizeCssPropertyName(property) {
  if (property.startsWith('--')) return property.toLowerCase();
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
}

function isTransparentAllowed(property) {
  if (structuralTransparentProperties.has(property)) return true;
  return /^border-(?:block|inline|top|right|bottom|left)(?:-(?:start|end))?-color$/.test(property);
}

function findRawColors(property, value) {
  const colorContext = isColorProperty(property);
  const colors = new Set();

  function visit(nodes, inColorFunction = false, inUrl = false) {
    for (const node of nodes) {
      if (
        node.type === 'hash' &&
        !inUrl &&
        /^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(node.value)
      ) {
        colors.add(`#${node.value}`);
        continue;
      }
      if (node.type === 'word') {
        if (!namedColors.has(node.value) && node.value !== 'transparent') continue;
        const isStructuralTransparent =
          node.value === 'transparent' && isTransparentAllowed(property);
        if (
          !isStructuralTransparent &&
          !cssWideKeywords.has(node.value) &&
          !semanticColorKeywords.has(node.value) &&
          (colorContext || inColorFunction)
        ) {
          colors.add(node.value);
        }
        continue;
      }
      if (node.type !== 'function') continue;
      const isUrl = inUrl || node.value === 'url';
      if (!isUrl && literalColorFunctions.has(node.value)) colors.add(`${node.value}()`);
      const isColor =
        inColorFunction ||
        colorContainerFunctions.has(node.value) ||
        node.value.endsWith('gradient') ||
        node.value === 'drop-shadow' ||
        ((node.value === 'var' || node.value === 'env') && colorContext);
      visit(node.children, isColor, isUrl);
    }
  }

  visit(parseCssValue(value));
  return [...colors];
}

function getStringLiterals(node) {
  const values = [];
  function visit(current) {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      values.push(current.text);
    } else if (
      ts.isTemplateHead(current) ||
      ts.isTemplateMiddle(current) ||
      ts.isTemplateTail(current)
    ) {
      values.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return values;
}

function checkTsxColorValue(file, node, property, sourceFile) {
  const normalizedProperty = normalizeCssPropertyName(property);
  if (!isColorProperty(normalizedProperty)) return;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  for (const literal of getStringLiterals(node)) {
    for (const color of findRawColors(normalizedProperty, literal)) {
      report(file, line, `raw TSX color ${color} in '${property}'; use a semantic theme token`);
    }
  }
}

function declarationSelector(declaration) {
  let parent = declaration.parent;
  while (parent && parent.type !== 'rule') parent = parent.parent;
  return parent?.type === 'rule' ? parent.selector.trim() : null;
}

function animationKey(file, selector, property, value) {
  return JSON.stringify([file, selector, property, value.replace(/\s+/g, ' ').trim()]);
}

function keyframeKey(file, name) {
  return JSON.stringify([file, name]);
}

function normalizedValue(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function objectPropertyName(property, sourceFile) {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isShorthandPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property)
  ) {
    return null;
  }
  return property.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
}

const allowedAnimations = baselineCounter(baseline.functionalAnimations, (entry) =>
  animationKey(entry.file, entry.selector, entry.property, entry.value),
);
const allowedTransitions = baselineCounter(baseline.functionalTransitions, (entry) =>
  animationKey(entry.file, entry.selector, entry.property, entry.value),
);
const allowedKeyframes = baselineCounter(baseline.functionalKeyframes, (entry) =>
  keyframeKey(entry.file, entry.name),
);
const allowedInlineStyles = baselineCounter(baseline.inlineStyles, (entry) =>
  baselineKey(entry.file, entry.element, entry.expression),
);

for (const cssPath of cssFiles) {
  const file = toRepositoryPath(cssPath);
  const source = fs.readFileSync(cssPath, 'utf8');
  let root;
  try {
    root = postcss.parse(source, { from: cssPath });
  } catch (error) {
    report(file, error.line ?? 1, `CSS parse failed: ${error.reason ?? error.message}`);
    continue;
  }

  const skipRawPalette = file === 'src/index.css';
  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const line = declaration.source?.start?.line ?? 1;
    const value = declaration.value.trim();
    const normalized = normalizedValue(value);

    if (!skipRawPalette) {
      for (const color of findRawColors(property, declaration.value)) {
        report(file, line, `raw CSS color ${color} in '${property}'; use a semantic theme token`);
      }
    }

    const valueNodes = parseCssValue(declaration.value);
    const visitEffects = (nodes) => {
      for (const node of nodes) {
        if (node.type !== 'function') continue;
        if (node.value.endsWith('gradient')) {
          report(file, line, `gradient function '${node.value}()' is forbidden`);
        }
        if (node.value === 'drop-shadow') {
          report(file, line, 'decorative drop-shadow filter is forbidden');
        }
        if (
          (property === 'transform' || property === 'scale') &&
          /^scale(?:[xyz])?$/.test(node.value)
        ) {
          report(file, line, `decorative scale transform '${node.value}()' is forbidden`);
        }
        visitEffects(node.children);
      }
    };
    visitEffects(valueNodes);

    if (
      (property === 'box-shadow' || property === 'text-shadow') &&
      !cssResetValues.has(normalized)
    ) {
      report(file, line, `decorative '${property}' is forbidden; remove it or use a flat boundary`);
    }

    if (property === 'scale' && !cssResetValues.has(normalized)) {
      report(file, line, 'decorative CSS scale property is forbidden');
    }

    if (property === 'transition' || property.startsWith('transition-')) {
      if (!cssResetValues.has(normalized)) {
        const selector = declarationSelector(declaration);
        const key = animationKey(file, selector, property, declaration.value);
        const count = (transitionCounts.get(key) ?? 0) + 1;
        transitionCounts.set(key, count);
        if (count > (allowedTransitions.get(key) ?? 0)) {
          report(file, line, `transition '${value}' is not in the functional transition baseline`);
        }
      }
    }

    if (property === 'animation' || property.startsWith('animation-')) {
      if (!cssResetValues.has(normalized)) {
        const selector = declarationSelector(declaration);
        const key = animationKey(file, selector, property, declaration.value);
        const count = (animationCounts.get(key) ?? 0) + 1;
        animationCounts.set(key, count);
        if (count > (allowedAnimations.get(key) ?? 0)) {
          report(file, line, `animation '${value}' is not in the functional animation baseline`);
        }
      }
    }
  });

  root.walkAtRules((atRule) => {
    if (!atRule.name.toLowerCase().endsWith('keyframes')) return;
    const line = atRule.source?.start?.line ?? 1;
    const name = atRule.params.trim().replace(/^(['"])(.*)\1$/, '$2');
    const key = keyframeKey(file, name);
    const count = (keyframeCounts.get(key) ?? 0) + 1;
    keyframeCounts.set(key, count);
    if (count > (allowedKeyframes.get(key) ?? 0)) {
      report(file, line, `keyframes '${name}' are not in the functional animation baseline`);
    }
  });
}

for (const tsxPath of tsxFiles) {
  const file = toRepositoryPath(tsxPath);
  const sourceText = fs.readFileSync(tsxPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    tsxPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const line = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
      : 1;
    report(
      file,
      line,
      `TSX parse failed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const property = objectPropertyName(node, sourceFile);
      if (property) checkTsxColorValue(file, node.initializer, property, sourceFile);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = node.tagName.getText(sourceFile);
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          const spreadValue = unwrapParentheses(attribute.expression);
          if (ts.isObjectLiteralExpression(spreadValue)) {
            for (const property of spreadValue.properties) {
              if (objectPropertyName(property, sourceFile) !== 'style') continue;
              const line =
                sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1;
              report(file, line, `inline style object spread onto <${element}> is forbidden`);
            }
          }
          continue;
        }
        if (ts.isJsxAttribute(attribute)) {
          const property = normalizeCssPropertyName(attribute.name.getText(sourceFile));
          if (attribute.initializer && isColorProperty(property)) {
            const value = ts.isJsxExpression(attribute.initializer)
              ? attribute.initializer.expression
              : attribute.initializer;
            if (value) checkTsxColorValue(file, value, property, sourceFile);
          }
        }
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(sourceFile) !== 'style')
          continue;

        let expression = '[missing value]';
        if (attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          if (attribute.initializer.expression) {
            expression = printer
              .printNode(ts.EmitHint.Expression, attribute.initializer.expression, sourceFile)
              .trim();
          }
        } else if (attribute.initializer) {
          expression = printer
            .printNode(ts.EmitHint.Expression, attribute.initializer, sourceFile)
            .trim();
        }

        const key = baselineKey(file, element, expression);
        const count = (styleCounts.get(key) ?? 0) + 1;
        styleCounts.set(key, count);
        if (count > (allowedInlineStyles.get(key) ?? 0)) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(attribute.getStart(sourceFile)).line + 1;
          report(
            file,
            line,
            `JSX style prop on <${element}> is not in the exact legacy baseline; move it to a CSS Module`,
          );
        }
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length > 1) {
      const callee = node.expression;
      const isCreateElement =
        (ts.isPropertyAccessExpression(callee) &&
          ['cloneElement', 'createElement'].includes(callee.name.text)) ||
        (ts.isIdentifier(callee) && ['cloneElement', 'createElement'].includes(callee.text));
      const props = node.arguments[1];
      const propsObject = ts.isExpression(props) ? unwrapParentheses(props) : props;
      if (isCreateElement && ts.isObjectLiteralExpression(propsObject)) {
        for (const property of propsObject.properties) {
          if (objectPropertyName(property, sourceFile) !== 'style') continue;
          const line =
            sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1;
          report(file, line, 'inline style object passed to createElement is forbidden');
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (failures.length > 0) {
  console.error(`Design-rule check failed with ${failures.length} finding(s):`);
  for (const failure of failures.sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const legacyStyleCount = [...allowedInlineStyles.values()].reduce((sum, count) => sum + count, 0);
  console.log(
    `Design-rule check passed (${cssFiles.length} CSS files, ${tsxFiles.length} TSX files; ${legacyStyleCount} exact legacy style props; functional animations allowlisted).`,
  );
}
