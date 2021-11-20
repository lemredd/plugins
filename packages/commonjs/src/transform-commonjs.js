/* eslint-disable no-param-reassign, no-shadow, no-underscore-dangle, no-continue */

import { dirname } from 'path';

import { attachScopes, extractAssignedNames } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';

import {
  getKeypath,
  hasDefineEsmProperty,
  isDefineCompiledEsm,
  isFalsy,
  isReference,
  isShorthandProperty,
  isTruthy,
  KEY_COMPILED_ESM
} from './ast-utils';
import { rewriteExportsAndGetExportsBlock, wrapCode } from './generate-exports';
import {
  getRequireHandlers,
  getRequireStringArg,
  hasDynamicModuleForPath,
  isIgnoredRequireStatement,
  isModuleRequire,
  isNodeRequirePropertyAccess,
  isRequireStatement,
  isStaticRequireStatement
} from './generate-imports';
import { IS_WRAPPED_COMMONJS } from './helpers';
import { tryParse } from './parse';
import { capitalize, deconflict, getName, getVirtualPathForDynamicRequirePath } from './utils';

const exportsPattern = /^(?:module\.)?exports(?:\.([a-zA-Z_$][a-zA-Z_$0-9]*))?$/;

const functionType = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

export default async function transformCommonjs(
  parse,
  code,
  id,
  isEsModule,
  ignoreGlobal,
  ignoreRequire,
  ignoreDynamicRequires,
  getIgnoreTryCatchRequireStatementMode,
  sourceMap,
  isDynamicRequireModulesEnabled,
  dynamicRequireModules,
  commonDir,
  astCache,
  defaultIsModuleExports,
  needsRequireWrapper,
  resolveRequireSourcesAndGetMeta,
  isRequired
) {
  const ast = astCache || tryParse(parse, code, id);
  const magicString = new MagicString(code);
  const uses = {
    module: false,
    exports: false,
    global: false,
    require: false
  };
  const virtualDynamicRequirePath =
    isDynamicRequireModulesEnabled && getVirtualPathForDynamicRequirePath(dirname(id), commonDir);
  let scope = attachScopes(ast, 'scope');
  let lexicalDepth = 0;
  let programDepth = 0;
  let currentTryBlockEnd = null;
  let shouldWrap = false;

  const globals = new Set();
  // A conditionalNode is a node for which execution is not guaranteed. If such a node is a require
  // or contains nested requires, those should be handled as function calls unless there is an
  // unconditional require elsewhere.
  let currentConditionalNodeEnd = null;
  const conditionalNodes = new Set();

  // TODO Lukas fix this at last, we are close
  // TODO technically wrong since globals isn't populated yet, but ¯\_(ツ)_/¯
  const helpersName = deconflict([scope], globals, 'commonjsHelpers');
  const dynamicRequireName = deconflict([scope], globals, 'commonjsRequire');

  const { addRequireStatement, rewriteRequireExpressionsAndGetImportBlock } = getRequireHandlers();

  // See which names are assigned to. This is necessary to prevent
  // illegally replacing `var foo = require('foo')` with `import foo from 'foo'`,
  // where `foo` is later reassigned. (This happens in the wild. CommonJS, sigh)
  const reassignedNames = new Set();
  const topLevelDeclarations = [];
  const skippedNodes = new Set();
  const moduleAccessScopes = new Set([scope]);
  const exportsAccessScopes = new Set([scope]);
  const moduleExportsAssignments = [];
  let firstTopLevelModuleExportsAssignment = null;
  const exportsAssignmentsByName = new Map();
  const topLevelAssignments = new Set();
  const topLevelDefineCompiledEsmExpressions = [];

  walk(ast, {
    enter(node, parent) {
      if (skippedNodes.has(node)) {
        this.skip();
        return;
      }

      if (currentTryBlockEnd !== null && node.start > currentTryBlockEnd) {
        currentTryBlockEnd = null;
      }
      if (currentConditionalNodeEnd !== null && node.start > currentConditionalNodeEnd) {
        currentConditionalNodeEnd = null;
      }
      if (currentConditionalNodeEnd === null && conditionalNodes.has(node)) {
        currentConditionalNodeEnd = node.end;
      }

      programDepth += 1;
      if (node.scope) ({ scope } = node);
      if (functionType.test(node.type)) lexicalDepth += 1;
      if (sourceMap) {
        magicString.addSourcemapLocation(node.start);
        magicString.addSourcemapLocation(node.end);
      }

      // eslint-disable-next-line default-case
      switch (node.type) {
        case 'AssignmentExpression':
          if (node.left.type === 'MemberExpression') {
            const flattened = getKeypath(node.left);
            if (!flattened || scope.contains(flattened.name)) return;

            const exportsPatternMatch = exportsPattern.exec(flattened.keypath);
            if (!exportsPatternMatch || flattened.keypath === 'exports') return;

            const [, exportName] = exportsPatternMatch;
            uses[flattened.name] = true;

            // we're dealing with `module.exports = ...` or `[module.]exports.foo = ...` –
            if (flattened.keypath === 'module.exports') {
              moduleExportsAssignments.push(node);
              if (programDepth > 3) {
                moduleAccessScopes.add(scope);
              } else if (!firstTopLevelModuleExportsAssignment) {
                firstTopLevelModuleExportsAssignment = node;
              }

              if (defaultIsModuleExports === false) {
                shouldWrap = true;
              } else if (defaultIsModuleExports === 'auto') {
                if (node.right.type === 'ObjectExpression') {
                  if (hasDefineEsmProperty(node.right)) {
                    shouldWrap = true;
                  }
                } else if (defaultIsModuleExports === false) {
                  shouldWrap = true;
                }
              }
            } else if (exportName === KEY_COMPILED_ESM) {
              if (programDepth > 3) {
                shouldWrap = true;
              } else {
                topLevelDefineCompiledEsmExpressions.push(node);
              }
            } else {
              const exportsAssignments = exportsAssignmentsByName.get(exportName) || {
                nodes: [],
                scopes: new Set()
              };
              exportsAssignments.nodes.push(node);
              exportsAssignments.scopes.add(scope);
              exportsAccessScopes.add(scope);
              exportsAssignmentsByName.set(exportName, exportsAssignments);
              if (programDepth <= 3) {
                topLevelAssignments.add(node);
              }
            }

            skippedNodes.add(node.left);
          } else {
            for (const name of extractAssignedNames(node.left)) {
              reassignedNames.add(name);
            }
          }
          return;
        case 'CallExpression': {
          if (isDefineCompiledEsm(node)) {
            if (programDepth === 3 && parent.type === 'ExpressionStatement') {
              // skip special handling for [module.]exports until we know we render this
              skippedNodes.add(node.arguments[0]);
              topLevelDefineCompiledEsmExpressions.push(node);
            } else {
              shouldWrap = true;
            }
            return;
          }

          // Transform require.resolve
          if (
            node.callee.object &&
            node.callee.object.name === 'require' &&
            node.callee.property.name === 'resolve' &&
            hasDynamicModuleForPath(id, '/', dynamicRequireModules)
          ) {
            // TODO Lukas reimplement?
            uses.require = true;
            const requireNode = node.callee.object;
            magicString.appendLeft(
              node.end - 1,
              `,${JSON.stringify(
                dirname(id) === '.' ? null /* default behavior */ : virtualDynamicRequirePath
              )}`
            );
            magicString.overwrite(requireNode.start, requireNode.end, dynamicRequireName, {
              storeName: true
            });
            return;
          }

          // Ignore call expressions of dynamic requires, the callee will be transformed within Identifier
          if (!isStaticRequireStatement(node, scope)) {
            return;
          }

          // Otherwise we do not want to replace "require" with the internal helper
          skippedNodes.add(node.callee);
          uses.require = true;

          if (!isIgnoredRequireStatement(node, ignoreRequire)) {
            const usesReturnValue = parent.type !== 'ExpressionStatement';
            addRequireStatement(
              getRequireStringArg(node),
              node,
              scope,
              usesReturnValue,
              currentTryBlockEnd !== null,
              currentConditionalNodeEnd !== null,
              parent.type === 'ExpressionStatement' ? parent : node
            );
          }
          return;
        }
        case 'ConditionalExpression':
        case 'IfStatement':
          // skip dead branches
          if (isFalsy(node.test)) {
            skippedNodes.add(node.consequent);
          } else if (isTruthy(node.test)) {
            if (node.alternate) {
              skippedNodes.add(node.alternate);
            }
          } else {
            conditionalNodes.add(node.consequent);
            if (node.alternate) {
              conditionalNodes.add(node.alternate);
            }
          }
          return;
        case 'ArrowFunctionExpression':
        case 'FunctionDeclaration':
        case 'FunctionExpression':
          // requires in functions should be conditional unless it is an IIFE
          if (
            currentConditionalNodeEnd === null &&
            !(parent.type === 'CallExpression' && parent.callee === node)
          ) {
            currentConditionalNodeEnd = node.end;
          }
          return;
        case 'Identifier': {
          const { name } = node;
          if (!isReference(node, parent) || scope.contains(name)) return;
          switch (name) {
            case 'require':
              uses.require = true;
              if (isNodeRequirePropertyAccess(parent)) {
                // TODO Lukas reimplement?
                if (hasDynamicModuleForPath(id, '/', dynamicRequireModules)) {
                  if (parent.property.name === 'cache') {
                    magicString.overwrite(node.start, node.end, dynamicRequireName, {
                      storeName: true
                    });
                  }
                }

                return;
              }

              if (isDynamicRequireModulesEnabled && isRequireStatement(parent, scope)) {
                magicString.appendLeft(
                  parent.end - 1,
                  `, ${JSON.stringify(
                    dirname(id) === '.' ? null /* default behavior */ : virtualDynamicRequirePath
                  )}`
                );
              }
              if (!ignoreDynamicRequires) {
                if (isShorthandProperty(parent)) {
                  magicString.appendRight(node.end, `: ${dynamicRequireName}`);
                } else {
                  magicString.overwrite(node.start, node.end, dynamicRequireName, {
                    storeName: true
                  });
                }
              }
              return;
            case 'module':
            case 'exports':
              shouldWrap = true;
              uses[name] = true;
              return;
            case 'global':
              uses.global = true;
              if (!ignoreGlobal) {
                magicString.overwrite(node.start, node.end, `${helpersName}.commonjsGlobal`, {
                  storeName: true
                });
              }
              return;
            case 'define':
              magicString.overwrite(node.start, node.end, 'undefined', {
                storeName: true
              });
              return;
            default:
              globals.add(name);
              return;
          }
        }
        case 'LogicalExpression':
          // skip dead branches
          if (node.operator === '&&') {
            if (isFalsy(node.left)) {
              skippedNodes.add(node.right);
            } else if (!isTruthy(node.left)) {
              conditionalNodes.add(node.right);
            }
          } else if (node.operator === '||') {
            if (isTruthy(node.left)) {
              skippedNodes.add(node.right);
            } else if (!isFalsy(node.left)) {
              conditionalNodes.add(node.right);
            }
          }
          return;
        case 'MemberExpression':
          if (!isDynamicRequireModulesEnabled && isModuleRequire(node, scope)) {
            uses.require = true;
            magicString.overwrite(node.start, node.end, dynamicRequireName, {
              storeName: true
            });
            skippedNodes.add(node.object);
            skippedNodes.add(node.property);
          }
          return;
        case 'ReturnStatement':
          // if top-level return, we need to wrap it
          if (lexicalDepth === 0) {
            shouldWrap = true;
          }
          return;
        case 'ThisExpression':
          // rewrite top-level `this` as `commonjsHelpers.commonjsGlobal`
          if (lexicalDepth === 0) {
            uses.global = true;
            if (!ignoreGlobal) {
              magicString.overwrite(node.start, node.end, `${helpersName}.commonjsGlobal`, {
                storeName: true
              });
            }
          }
          return;
        case 'TryStatement':
          if (currentTryBlockEnd === null) {
            currentTryBlockEnd = node.block.end;
          }
          return;
        case 'UnaryExpression':
          // rewrite `typeof module`, `typeof module.exports` and `typeof exports` (https://github.com/rollup/rollup-plugin-commonjs/issues/151)
          if (node.operator === 'typeof') {
            const flattened = getKeypath(node.argument);
            if (!flattened) return;

            if (scope.contains(flattened.name)) return;

            if (
              flattened.keypath === 'module.exports' ||
              flattened.keypath === 'module' ||
              flattened.keypath === 'exports'
            ) {
              magicString.overwrite(node.start, node.end, `'object'`, {
                storeName: false
              });
            }
          }
          return;
        case 'VariableDeclaration':
          if (!scope.parent) {
            topLevelDeclarations.push(node);
          }
      }
    },

    leave(node) {
      programDepth -= 1;
      if (node.scope) scope = scope.parent;
      if (functionType.test(node.type)) lexicalDepth -= 1;
    }
  });

  const nameBase = getName(id);
  const exportsName = deconflict([...exportsAccessScopes], globals, nameBase);
  const moduleName = deconflict([...moduleAccessScopes], globals, `${nameBase}Module`);
  const requireName = deconflict([scope], globals, `require${capitalize(nameBase)}`);
  const isRequiredName = deconflict([scope], globals, `hasRequired${capitalize(nameBase)}`);
  const deconflictedExportNames = Object.create(null);
  for (const [exportName, { scopes }] of exportsAssignmentsByName) {
    deconflictedExportNames[exportName] = deconflict([...scopes], globals, exportName);
  }

  // We cannot wrap ES/mixed modules
  shouldWrap = !isEsModule && (shouldWrap || (uses.exports && moduleExportsAssignments.length > 0));
  const detectWrappedDefault =
    shouldWrap &&
    (topLevelDefineCompiledEsmExpressions.length > 0 || code.indexOf('__esModule') >= 0);

  if (
    !(
      shouldWrap ||
      isRequired ||
      uses.module ||
      uses.exports ||
      uses.require ||
      topLevelDefineCompiledEsmExpressions.length > 0
    ) &&
    (ignoreGlobal || !uses.global)
  ) {
    return { meta: { commonjs: { isCommonJS: false, isMixedModule: false } } };
  }

  let leadingComment = '';
  if (code.startsWith('/*')) {
    const commentEnd = code.indexOf('*/', 2) + 2;
    leadingComment = `${code.slice(0, commentEnd)}\n`;
    magicString.remove(0, commentEnd).trim();
  }

  const exportMode = shouldWrap
    ? uses.module
      ? 'module'
      : 'exports'
    : firstTopLevelModuleExportsAssignment
    ? exportsAssignmentsByName.size === 0 && topLevelDefineCompiledEsmExpressions.length === 0
      ? 'replace'
      : 'module'
    : moduleExportsAssignments.length === 0
    ? 'exports'
    : 'module';

  const { importBlock, usesRequireWrapper } = await rewriteRequireExpressionsAndGetImportBlock(
    magicString,
    topLevelDeclarations,
    reassignedNames,
    helpersName,
    dynamicRequireName,
    moduleName,
    exportsName,
    id,
    exportMode,
    resolveRequireSourcesAndGetMeta,
    needsRequireWrapper,
    isEsModule,
    uses.require,
    getIgnoreTryCatchRequireStatementMode
  );
  const exportBlock = isEsModule
    ? ''
    : rewriteExportsAndGetExportsBlock(
        magicString,
        moduleName,
        exportsName,
        shouldWrap,
        moduleExportsAssignments,
        firstTopLevelModuleExportsAssignment,
        exportsAssignmentsByName,
        topLevelAssignments,
        topLevelDefineCompiledEsmExpressions,
        deconflictedExportNames,
        code,
        helpersName,
        exportMode,
        detectWrappedDefault,
        defaultIsModuleExports,
        usesRequireWrapper,
        requireName
      );

  if (shouldWrap) {
    wrapCode(magicString, uses, moduleName, exportsName);
  }

  if (usesRequireWrapper) {
    magicString.trim().indent('\t');
    magicString.prepend(
      `var ${isRequiredName};

function ${requireName} () {
\tif (${isRequiredName}) return ${exportsName};
\t${isRequiredName} = 1;
`
    ).append(`
\treturn ${exportsName};
}`);
    if (exportMode === 'replace') {
      magicString.prepend(`var ${exportsName};\n`);
    }
  }

  magicString
    .trim()
    .prepend(leadingComment + importBlock)
    .append(exportBlock);

  return {
    code: magicString.toString(),
    map: sourceMap ? magicString.generateMap() : null,
    syntheticNamedExports: isEsModule || usesRequireWrapper ? false : '__moduleExports',
    meta: {
      commonjs: {
        isCommonJS: !isEsModule && (usesRequireWrapper ? IS_WRAPPED_COMMONJS : true),
        isMixedModule: isEsModule
      }
    }
  };
}
