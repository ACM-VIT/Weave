'use strict';

const utils = require('./utils');

module.exports = (ast, options = {}, limit = options.maxDepth, initialDepth = ast.type === 'root' ? 0 : 1) => {
  const maxDepth = utils.getMaxDepth(limit);
  if (!Number.isInteger(initialDepth) || initialDepth < (ast.type === 'root' ? 0 : 1)) {
    throw new RangeError('Invalid AST initial depth');
  }

  const stringify = (node, parent = {}, depth = 0) => {
    if (node.nodes && depth > maxDepth) {
      throw new RangeError(`AST depth (${depth}), exceeds max depth (${maxDepth})`);
    }
    const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    let output = '';

    if (node.value) {
      if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
        return '\\' + node.value;
      }
      return node.value;
    }

    if (node.value) {
      return node.value;
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        output += stringify(child, undefined, child.nodes ? depth + 1 : depth);
      }
    }
    return output;
  };

  return stringify(ast, {}, initialDepth);
};
